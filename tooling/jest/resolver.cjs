// NodeNext source imports its siblings as `./x.js`, which exists only after a build. In our own
// source, resolve those to `./x.ts`; dependencies resolve exactly as written.
// CommonJS because Jest loads resolvers synchronously.
'use strict';

const relativeJs = /^\.{1,2}\/.*\.js$/;

/** @type {import('jest-resolve').SyncResolver} */
module.exports = (request, options) => {
  if (relativeJs.test(request) && !options.basedir.includes('/node_modules/')) {
    try {
      return options.defaultResolver(`${request.slice(0, -3)}.ts`, options);
    } catch {
      // Not TypeScript after all (e.g. a .js script); resolve it as written.
    }
  }
  return options.defaultResolver(request, options);
};
