'use strict';

const {
  runInNewContext,
  runInThisContext,
  constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER },
} = require('vm');
const { setFlagsFromString } = require('v8');
const { parentPort, workerData } = require('worker_threads');


if (workerData.needsGc) {
  // See https://github.com/nodejs/node/issues/16595#issuecomment-340288680
  setFlagsFromString('--expose-gc');
  globalThis.gc = runInNewContext('gc');
}

// globalThis.self = global;
// globalThis.GLOBAL = {
//   isWindow() { return false; },
//   isShadowRealm() { return false; },
// };
// globalThis.require = require;


if (workerData.initScript) {
  runInThisContext(workerData.initScript, {
    importModuleDynamically: USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
}

runInThisContext(workerData.harness.code, {
  filename: workerData.harness.filename,
  importModuleDynamically: USE_MAIN_CONTEXT_DEFAULT_LOADER,
});

// eslint-disable-next-line no-undef
add_result_callback((result) => {
  parentPort.postMessage({
    type: 'result',
    result: {
      status: result.status,
      name: result.name,
      message: result.message,
      stack: result.stack,
    },
  });
});

// Keep the event loop alive
const timeout = setTimeout(() => {
  parentPort.postMessage({
    type: 'completion',
    status: { status: 2 },
  });
}, 2 ** 31 - 1); // Max timeout is 2^31-1, when overflown the timeout is set to 1.

// eslint-disable-next-line no-undef
add_completion_callback((_, status) => {
  clearTimeout(timeout);
  parentPort.postMessage({
    type: 'completion',
    status,
  });
});

for (const scriptToRun of workerData.scriptsToRun) {
  try {
    runInThisContext(scriptToRun.code, {
      filename: scriptToRun.filename,
      importModuleDynamically: USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
  } catch (e) {
    console.log(scriptToRun.filename)
    console.log(scriptToRun.code)
    throw e
  }
}
