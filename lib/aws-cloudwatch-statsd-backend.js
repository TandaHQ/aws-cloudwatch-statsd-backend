var util = require('util');
var { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
var { fromInstanceMetadata } = require('@aws-sdk/credential-providers');

function CloudwatchBackend(startupTime, config, emitter) {
  var self = this;

  this.config = config || {};

  async function setEmitter() {
    // Prepare client configuration
    var clientConfig = {
      region: self.config.region
    };

    // Handle credentials based on iamRole configuration
    if (self.config.iamRole) {
      // Use instance metadata credentials for IAM role
      clientConfig.credentials = fromInstanceMetadata({
        timeout: 5000,
        maxRetries: 3
      });
    } else if (self.config.accessKeyId && self.config.secretAccessKey) {
      // Use explicit credentials if provided
      clientConfig.credentials = {
        accessKeyId: self.config.accessKeyId,
        secretAccessKey: self.config.secretAccessKey
      };
      if (self.config.sessionToken) {
        clientConfig.credentials.sessionToken = self.config.sessionToken;
      }
    }

    // Create CloudWatch client with SDK v3
    self.cloudwatch = new CloudWatchClient(clientConfig);
    emitter.on('flush', function(timestamp, metrics) { self.flush(timestamp, metrics); });
  }

  // Call setEmitter - wrap in try/catch for credential errors
  setEmitter().catch(function(err) {
    console.log('Failed to initialize CloudWatch client: ' + err);
  });
};

CloudwatchBackend.prototype.processKey = function(key) {
  var parts = key.split(/[\.\/-]/);

  return {
    metricName: parts[parts.length - 1],
    namespace: parts.length > 1 ? parts.splice(0, parts.length - 1).join("/") : null
  };
};

CloudwatchBackend.prototype.isBlacklisted = function(key) {

  var blacklisted = false;

  // First check if key is whitelisted
  if (this.config.whitelist && this.config.whitelist.length > 0 && this.config.whitelist.indexOf(key) >= 0) {
      // console.log("Key (counter) " + key + " is whitelisted");
      return false;
  }

  if (this.config.blacklist && this.config.blacklist.length > 0) {
    for (var i = 0; i < this.config.blacklist.length; i++) {
      if (key.indexOf(this.config.blacklist[i]) >= 0) {
        blacklisted = true;
        break;
      }
    }
  }
  return blacklisted;
};

CloudwatchBackend.prototype.chunk = function(arr, chunkSize) {

  var groups = [],
    i;
  for (i = 0; i < arr.length; i += chunkSize) {
    groups.push(arr.slice(i, i + chunkSize));
  }
  return groups;
};

CloudwatchBackend.prototype.batchSend = async function(currentMetricsBatch, namespace) {

  // send off the array (instead of one at a time)
  if (currentMetricsBatch.length > 0) {

    // Chunk into groups of 20
    var chunkedGroups = this.chunk(currentMetricsBatch, 20);

    // Send all chunks in parallel
    var promises = [];
    for (var i = 0, len = chunkedGroups.length; i < len; i++) {
      var command = new PutMetricDataCommand({
        MetricData: chunkedGroups[i],
        Namespace: namespace
      });

      promises.push(
        this.cloudwatch.send(command).catch(function(err) {
          // log an error
          console.log(util.inspect(err));
        })
      );
    }

    // Wait for all requests to complete
    await Promise.all(promises);
  }
};

CloudwatchBackend.prototype.flush = function(timestamp, metrics) {
  var self = this;

  console.log('Flushing metrics at ' + new Date(timestamp * 1000).toISOString());

  var counters = metrics.counters;
  var gauges = metrics.gauges;
  var timers = metrics.timers;
  var sets = metrics.sets;

  // Wrap async operations in an async function
  (async function() {
    // put all currently accumulated counter metrics into an array
    var currentCounterMetrics = [];
    var namespace = "AwsCloudWatchStatsdBackend";
    for (key in counters) {
      if (key.indexOf('statsd.') == 0)
        continue;

      if (self.isBlacklisted(key)) {
        continue;
      }

      var names = self.config.processKeyForNamespace ? self.processKey(key) : {};
      namespace = self.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
      var metricName = self.config.metricName || names.metricName || key;

      currentCounterMetrics.push({
        MetricName: metricName,
        Unit: 'Count',
        Timestamp: new Date(timestamp * 1000).toISOString(),
        Value: counters[key]
      });
    }

    await self.batchSend(currentCounterMetrics, namespace);

    // put all currently accumulated timer metrics into an array
    var currentTimerMetrics = [];
    for (key in timers) {
      if (timers[key].length > 0) {

        if (self.isBlacklisted(key)) {
          continue;
        }

        var values = timers[key].sort(function(a, b) {
          return a - b;
        });
        var count = values.length;
        var min = values[0];
        var max = values[count - 1];

        var cumulativeValues = [min];
        for (var i = 1; i < count; i++) {
          cumulativeValues.push(values[i] + cumulativeValues[i - 1]);
        }

        var sum = min;
        var mean = min;
        var maxAtThreshold = max;

        var message = "";

        var key2;

        sum = cumulativeValues[count - 1];
        mean = sum / count;

        var names = self.config.processKeyForNamespace ? self.processKey(key) : {};
        namespace = self.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
        var metricName = self.config.metricName || names.metricName || key;

        currentTimerMetrics.push({
          MetricName: metricName,
          Unit: 'Milliseconds',
          Timestamp: new Date(timestamp * 1000).toISOString(),
          StatisticValues: {
            Minimum: min,
            Maximum: max,
            Sum: sum,
            SampleCount: count
          }
        });
      }
    }

    await self.batchSend(currentTimerMetrics, namespace);

    // put all currently accumulated gauge metrics into an array
    var currentGaugeMetrics = [];
    for (key in gauges) {

      if (self.isBlacklisted(key)) {
        continue;
      }

      var names = self.config.processKeyForNamespace ? self.processKey(key) : {};
      namespace = self.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
      var metricName = self.config.metricName || names.metricName || key;

      currentGaugeMetrics.push({
        MetricName: metricName,
        Unit: 'None',
        Timestamp: new Date(timestamp * 1000).toISOString(),
        Value: gauges[key]
      });
    }

    await self.batchSend(currentGaugeMetrics, namespace);

    // put all currently accumulated set metrics into an array
    var currentSetMetrics = [];
    for (key in sets) {

      if (self.isBlacklisted(key)) {
        continue;
      }

      var names = self.config.processKeyForNamespace ? self.processKey(key) : {};
      namespace = self.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
      var metricName = self.config.metricName || names.metricName || key;

      currentSetMetrics.push({
        MetricName: metricName,
        Unit: 'None',
        Timestamp: new Date(timestamp * 1000).toISOString(),
        Value: sets[key].values().length
      });
    }

    await self.batchSend(currentSetMetrics, namespace);
  })().catch(function(err) {
    console.log('Error flushing metrics: ' + err);
  });
};

exports.init = function(startupTime, config, events) {
  var cloudwatch = config.cloudwatch || {};
  var instances = cloudwatch.instances || [cloudwatch];
  for (key in instances) {
    instanceConfig = instances[key];
    console.log("Starting cloudwatch reporter instance in region:", instanceConfig.region);
    var instance = new CloudwatchBackend(startupTime, instanceConfig, events);
  }
  return true;
};
