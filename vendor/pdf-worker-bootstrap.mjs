// PDF.js runs in a separate worker, so install the compatibility shim there too.
if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
if (!Promise.withResolver) Promise.withResolver = Promise.withResolvers;
import './pdf.worker.min.mjs';
