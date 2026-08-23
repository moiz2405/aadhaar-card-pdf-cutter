// Compatibility for browsers such as Windows 7 Chrome that lack Promise.withResolvers.
(function () {
  if (typeof Promise === 'undefined') return;
  if (!Promise.withResolvers) {
    Promise.withResolvers = function () {
      var resolve;
      var reject;
      var promise = new Promise(function (res, rej) {
        resolve = res;
        reject = rej;
      });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }
  if (!Promise.withResolver) Promise.withResolver = Promise.withResolvers;
}());
