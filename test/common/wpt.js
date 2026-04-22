'use strict';

const assert = require('assert');
const fixtures = require('../common/fixtures');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const events = require('events');
const os = require('os');
const { inspect } = require('util');
const { Worker } = require('worker_threads');

const workerPath = path.join(__dirname, 'wpt/worker.js');

const wptpath = path.join(__dirname, '..', '..', '..', '..', 'tests', 'web-platform-tests');

async function fetchText(url) {
  const response = await fetch(url);
  return await response.text();
}

const runtime = process.argv[2];

async function runTest(content, url) {
  // console.log(`Starting test ${url}`);

  const tempFilePath = await Deno.makeTempFile();
  // console.log("Temp file path:", tempFilePath);
  await Deno.writeTextFile(tempFilePath, content);
  // const data = await Deno.readTextFile(tempFilePath);
  // console.log("Temp file data:", data);
  const command = new Deno.Command(runtime, {
    args: [tempFilePath],
  });

  // create subprocess and collect output
  const { code, stdout, stderr } = await command.output();
  const stdoutT = new TextDecoder().decode(stdout);
  const results = stdoutT.split("\n").filter(line => line).map(line => {
    try { return JSON.parse(line) }
    catch (e) {
      // console.log(url)
      // console.log("------------------------------------------------")
      // console.log(stdoutT)
      // console.log("------------------------------------------------")
      // throw e;
      // Note that tests can run `console.log`
      return undefined;
    }
  }).filter(line => line);

  // console.assert(code === 0);
  // console.log();
  // console.log();
  if (code === 0) {
    // await Deno.remove(tempFilePath);
  }
  // console.log(`Finishing test ${url}`);
  // console.log(results)
  return {
    code,
    results,
    stderr: new TextDecoder().decode(stderr),
    path: tempFilePath,
  }
}

function getBrowserProperties() {
  const { node: version } = process.versions; // e.g. 18.13.0, 20.0.0-nightly202302078e6e215481
  const release = /^\d+\.\d+\.\d+$/.test(version);
  const browser = {
    browser_channel: release ? 'stable' : 'experimental',
    browser_version: version,
  };

  return browser;
}

/**
 * Return one of three expected values
 * https://github.com/web-platform-tests/wpt/blob/1c6ff12/tools/wptrunner/wptrunner/tests/test_update.py#L953-L958
 * @returns {'linux'|'mac'|'win'}
 */
function getOs() {
  switch (os.type()) {
    case 'Linux':
      return 'linux';
    case 'Darwin':
      return 'mac';
    case 'Windows_NT':
      return 'win';
    default:
      throw new Error('Unsupported os.type()');
  }
}

// https://github.com/web-platform-tests/wpt/blob/b24eedd/resources/testharness.js#L3705
function sanitizeUnpairedSurrogates(str) {
  return str.replace(
    /([\ud800-\udbff]+)(?![\udc00-\udfff])|(^|[^\ud800-\udbff])([\udc00-\udfff]+)/g,
    function(_, low, prefix, high) {
      let output = prefix || '';  // Prefix may be undefined
      const string = low || high;  // Only one of these alternates can match
      for (let i = 0; i < string.length; i++) {
        output += codeUnitStr(string[i]);
      }
      return output;
    });
}

function codeUnitStr(char) {
  return 'U+' + char.charCodeAt(0).toString(16);
}

class ReportResult {
  #startTime;

  constructor(name) {
    this.test = name;
    this.status = 'OK';
    this.subtests = [];
    this.#startTime = Date.now();
  }

  addSubtest(name, status, message) {
    const subtest = {
      status,
      // https://github.com/web-platform-tests/wpt/blob/b24eedd/resources/testharness.js#L3722
      name: sanitizeUnpairedSurrogates(name),
    };
    if (message) {
      // https://github.com/web-platform-tests/wpt/blob/b24eedd/resources/testharness.js#L4506
      subtest.message = sanitizeUnpairedSurrogates(message);
    }
    this.subtests.push(subtest);
    return subtest;
  }

  finish(status) {
    this.status = status ?? 'OK';
    this.duration = Date.now() - this.#startTime;
  }
}

// Generates a report that can be uploaded to wpt.fyi.
// Checkout https://github.com/web-platform-tests/wpt.fyi/tree/main/api#results-creation
// for more details.
class WPTReport {
  constructor() {
    this.filename = `report.json`;
    /** @type {Map<string, ReportResult>} */
    this.results = new Map();
    this.time_start = Date.now();
  }

  /**
   * Get or create a ReportResult for a test spec.
   * @param {WPTTestSpec} spec
   * @returns {ReportResult}
   */
  getResult(spec) {
    const name = `/${spec.url}`;
    if (this.results.has(name)) {
      return this.results.get(name);
    }
    const result = new ReportResult(name);
    this.results.set(name, result);
    return result;
  }

  /**
   * @returns {void}
   */
  write() {
    this.time_end = Date.now();
    const results = Array.from(this.results.values())
      .map((result) => {
        const url = new URL(result.test, 'http://wpt');
        url.pathname = url.pathname.replace(/\.js$/, '.html');
        result.test = url.href.slice(url.origin.length);
        return result;
      });

    /**
     * Return required and some optional properties
     * https://github.com/web-platform-tests/wpt.fyi/blob/60da175/api/README.md?plain=1#L331-L335
     */
    this.run_info = {
      product: 'node.js',
      ...getBrowserProperties(),
      revision: process.env.WPT_REVISION || 'unknown',
      os: getOs(),
    };

    fs.writeFileSync(`out/wpt/${this.filename}`, JSON.stringify({
      time_start: this.time_start,
      time_end: this.time_end,
      run_info: this.run_info,
      results: results,
    }));
  }
}

// https://github.com/web-platform-tests/wpt/blob/HEAD/resources/testharness.js
// TODO: get rid of this half-baked harness in favor of the one
// pulled from WPT
const harnessMock = {
  test: (fn, desc) => {
    try {
      fn();
    } catch (err) {
      console.error(`In ${desc}:`);
      throw err;
    }
  },
  assert_equals: assert.strictEqual,
  assert_true: (value, message) => assert.strictEqual(value, true, message),
  assert_false: (value, message) => assert.strictEqual(value, false, message),
  assert_throws: (code, func, desc) => {
    assert.throws(func, function(err) {
      return typeof err === 'object' &&
             'name' in err &&
             err.name.startsWith(code.name);
    }, desc);
  },
  assert_array_equals: assert.deepStrictEqual,
  assert_unreached(desc) {
    assert.fail(`Reached unreachable code: ${desc}`);
  },
};

class ResourceLoader {
  constructor() {
    // this.path = path;
  }

  toRealFilePath(from, url) {
    // We need to patch this to load the WebIDL parser
    url = url.replace(
      '/resources/WebIDLParser.js',
      '/resources/webidl2/lib/webidl2.js',
    );
    const base = path.dirname(from);
    return url.startsWith('/') ?
      path.join(wptpath, url) :
      path.join(wptpath, base, url);
  }

  /**
   * Load a resource in test/fixtures/wpt specified with a URL
   * @param {string} from the path of the file loading this resource,
   *   relative to the WPT folder.
   * @param {string} url the url of the resource being loaded.
   * @returns {string}
   */
  read(from, url) {
    const file = this.toRealFilePath(from, url);
    return fs.readFileSync(file, 'utf8');
  }

  /**
   * Load a resource in test/fixtures/wpt specified with a URL
   * @param {string} from the path of the file loading this resource,
   *   relative to the WPT folder.
   * @param {string} url the url of the resource being loaded.
   * @returns {Promise<{
   *   ok: string,
   *   arrayBuffer: function(): Buffer,
   *   json: function(): object,
   *   text: function(): string,
   * }>}
   */
  async readAsFetch(from, url) {
    const file = this.toRealFilePath(from, url);
    const data = await fsPromises.readFile(file);
    return {
      ok: true,
      arrayBuffer() { return data.buffer; },
      bytes() { return new Uint8Array(data); },
      json() { return JSON.parse(data.toString()); },
      text() { return data.toString(); },
    };
  }
}

// A specification of WPT test
class WPTTestSpec {
  #content;

  /**
   * @param {string} filename path of the test, relative to mod, e.g.
   *   'html/webappapis/microtask-queuing/test.any.html' (TODO)
   */
  constructor(filename) {
    // FIXME do elsewhere
    filename = filename.replace(".any.html", ".any.js");
    this.filename = filename;
    // console.log(`this.filename = ${filename} (${typeof filename})`);
    this.url = new URL(filename, "http://web-platform.test:8000");
  }

  /**
   * @returns {{ script?: string[]; variant?: string[]; [key: string]: string }} parsed META tags of a spec file
   */
  static getMeta(content) {
    const matches = content.match(/\/\/ META: .+/g);
    if (!matches) {
      return {};
    }
    const result = {};
    for (const match of matches) {
      const parts = match.match(/\/\/ META: ([^=]+?)=(.+)/);
      const key = parts[1];
      const value = parts[2];
      if (key === 'variant') {
        continue;
      }
      if (key === 'script') {
        if (result[key]) {
          result[key].push(value);
        } else {
          result[key] = [value];
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

class StatusLoader {
  /**
   * @param {string} path relative path of the WPT subset
   */
  constructor(expectationsPath) {
    /** @type {WPTTestSpec[]} */
    this.specs = this.grep(expectationsPath).map(file => new WPTTestSpec(file));
  }

  grep2(path, tree, result) {
    for (const [k, v] of Object.entries(tree)) {
      // console.log(path, k, result)
      let subpath = path + "/" + k;
      if (v === true) {
        if (!k.includes(".any.html")) {
          console.error(subpath);
        } else {
          result.push(subpath);
        }
      } else {
        this.grep2(subpath, v, result);
      }
    }
  }

  /**
   * Build the list of tests from a tree-shaped JSON file
   * @param {string} expectationsPath
   * @returns {any[]}
   */
  grep(expectationsPath) {
    let tests = JSON.parse(fs.readFileSync(expectationsPath, 'utf8'));
    let result = [];
    this.grep2("", tests, result);
    return result;
  }
}

const kPass = 'pass';
const kFail = 'fail';
const kSkip = 'skip';
const kTimeout = 'timeout';
const kIncomplete = 'incomplete';
const kUncaught = 'uncaught';
const NODE_UNCAUGHT = 100;

const limit = (concurrency) => {
  let running = 0;
  const queue = [];

  const execute = async (fn) => {
    if (running < concurrency) {
      running++;
      try {
        await fn();
      } finally {
        running--;
        if (queue.length > 0) {
          execute(queue.shift());
        }
      }
    } else {
      queue.push(fn);
    }
  };

  return execute;
};

class WPTRunner {
  constructor(expectationsPath, { concurrency = os.availableParallelism() - 1 || 1 } = {}) {
    // RISC-V has very limited virtual address space in the currently common
    // sv39 mode, in which we can only create a very limited number of wasm
    // memories(27 from a fresh node repl). Limit the concurrency to avoid
    // creating too many wasm memories that would fail.
    if (process.arch === 'riscv64' || process.arch === 'riscv32') {
      concurrency = Math.min(10, concurrency);
    }

    this.resource = new ResourceLoader();
    this.concurrency = concurrency;

    this.status = new StatusLoader(expectationsPath);
    this.specs = new Set(this.status.specs);

    this.results = {};
    this.inProgress = new Set();
    this.workers = new Map();
    this.unexpectedFailures = [];

    if (process.env.WPT_REPORT != null) {
      this.report = new WPTReport();
    }
  }

  /**
   * @param {WPTTestSpec} spec
   * @returns {string}
   */
  fullInitScript(url, title, harness) {
    let initScript = `
    function sanitizeUnpairedSurrogates(str) {
      return str.replace(
        /([\ud800-\udbff]+)(?![\udc00-\udfff])|(^|[^\ud800-\udbff])([\udc00-\udfff]+)/g,
        function(_, low, prefix, high) {
          let output = prefix || '';  // Prefix may be undefined
          const string = low || high;  // Only one of these alternates can match
          for (let i = 0; i < string.length; i++) {
            output += codeUnitStr(string[i]);
          }
          return output;
        });
    }

    function codeUnitStr(char) {
      return 'U+' + char.charCodeAt(0).toString(16);
    }

      globalThis.self = globalThis; //TODO: must be implemented per mca
      globalThis.location = new URL("${url}");
      globalThis.GLOBAL = {
        isWindow() { return false; },
        isShadowRealm() { return false; },
      };
    `;
    if (title) {
      initScript = `${initScript}\nglobalThis.META_TITLE = "${title}";`;
    }
    initScript += harness
    initScript += `
      add_result_callback((result) => {
        console.log(JSON.stringify({
          type: 'result',
          result: {
            status: result.status,
            name: result.name,
            message: result.message,
            stack: result.stack,
          },
        }));
      });
      add_completion_callback((_, status) => {
        //clearTimeout(timeout);
        console.log(JSON.stringify({
          type: 'completion',
          status,
        }));
      });
    `;

    return initScript;
  }

  async runJsTests() {
    const queue = this.buildQueue();

    const run = limit(this.concurrency);

    const harnessPath = "http://web-platform.test:8000/resources/testharness.js";
    const harness = await fetchText(harnessPath);
    for (const spec of queue) {
      const testPath = spec.url;
      const content = await fetchText(testPath);
      const meta = WPTTestSpec.getMeta(content);

      const scriptsToRun = [
        { filename: "Init script", code: this.fullInitScript(spec.url.href, meta.title, harness) }
      ];

      // Scripts specified with the `// META: script=` header
      if (meta.script) {
        const scripts = await Promise.all(meta.script.map(async (script) => {
          const path = new URL(script, testPath);
          const data = await fetchText(path);
          const obj = {
            code: data,
            filename: path.toString(),
          };
          return obj;
        }));
        scriptsToRun.push(...scripts);
      }
      // The actual test
      const obj = {
        code: content,
        filename: spec.url.toString(),
      };
      scriptsToRun.push(obj);
      const script = scriptsToRun.map(({code, filename}) => `// ${filename}\n${code}\n;`).join("\n");


      run(async () => {
        const reportResult = this.report?.getResult(spec);
        this.inProgress.add(spec);
        let { code, results, stderr, path } = await runTest(script, spec.url);
        if (code !== 0) {
          // Generate a subtest failure for visibility.
          // No need to record this synthetic failure with wpt.fyi.
          this.fail(
            spec,
            {
              status: NODE_UNCAUGHT,
              // name: `${err}`,
              message: stderr,
              // stack: inspect(err),
            },
            kUncaught,
          );
          // Mark the whole test as failed in wpt.fyi report.
          reportResult?.finish('ERROR');
          this.inProgress.delete(spec);
          this.report?.write();
          return;
        }
        for (const result of results) {
          // console.log(result);
          switch (result.type) {
            case 'result':
              this.resultCallback(spec, result.result, reportResult);
              break;
            case 'completion':
              this.completionCallback(spec, result.status, reportResult);
              break;
            default:
              throw new Error(`Unexpected message from worker: ${result.type}`);
          }
        }
        this.inProgress.delete(spec);
        return;
        const worker = new Worker(workerPath, {
          execArgv: [],
          workerData: {
            // testRelativePath: relativePath,
            wptRunner: __filename,
            wptPath: this.path,
            initScript: this.fullInitScript(spec.url.href, content),
            harness: {
              code: harness,
              filename: harnessPath,
            },
            script,
            needsGc: !!meta.script?.find((script) => script === '/common/gc.js'),
          },
        });
        this.workers.set(spec, worker);

        worker.on('message', (message) => {
        });

        worker.on('error', (err) => {
          if (!this.inProgress.has(spec)) {
            // The test is already finished. Ignore errors that occur after it.
            // This can happen normally, for example in timers tests.
            return;
          }
        });

        await events.once(worker, 'exit').catch(() => {});
      });
    }

    process.on('exit', () => {
      for (const spec of this.inProgress) {
        // No need to record this synthetic failure with wpt.fyi.
        this.fail(spec, { name: 'Incomplete' }, kIncomplete);
        // Mark the whole test as failed in wpt.fyi report.
        const reportResult = this.report?.getResult(spec);
        reportResult?.finish('ERROR');
      }
      inspect.defaultOptions.depth = Infinity;
      // Sorts the rules to have consistent output
      console.log('');
      console.log(JSON.stringify(Object.keys(this.results).sort().reduce(
        (obj, key) => {
          obj[key] = this.results[key];
          return obj;
        },
        {},
      ), null, 2));

      const failures = [];
      let expectedFailures = 0;
      let skipped = 0;
      for (const [key, item] of Object.entries(this.results)) {
        if (item.fail?.unexpected) {
          failures.push(key);
        }
      }

      // Write the report on clean exit. The report is also written
      // incrementally after each spec completes (see completionCallback)
      // so that results survive if the process is killed.
      this.report?.write();

      const ran = queue.length;
      const total = ran + skipped;
      const passed = ran - expectedFailures - failures.length;
      console.log('');
      console.log(`Ran ${ran}/${total} tests, ${passed} passed, ${failures.length} failures`);
    });
  }

  // Map WPT test status to strings
  getTestStatus(status) {
    switch (status) {
      case 1:
        return kFail;
      case 2:
        return kTimeout;
      case 3:
        return kIncomplete;
      case NODE_UNCAUGHT:
        return kUncaught;
      default:
        return kPass;
    }
  }

  /**
   * Report the status of each specific test case (there could be multiple
   * in one test file).
   * @param {WPTTestSpec} spec
   * @param {Test} test The Test object returned by WPT harness
   * @param {ReportResult} reportResult The report result object
   */
  resultCallback(spec, test, reportResult) {
    const status = this.getTestStatus(test.status);
    if (status !== kPass) {
      this.fail(spec, test, status, reportResult);
    } else {
      this.succeed(test, status, reportResult);
    }
  }

  /**
   * Report the status of each WPT test (one per file)
   * @param {WPTTestSpec} spec
   * @param {object} harnessStatus - The status object returned by WPT harness.
   * @param {ReportResult} reportResult The report result object
   */
  completionCallback(spec, harnessStatus, reportResult) {
    const status = this.getTestStatus(harnessStatus.status);

    // Treat it like a test case failure
    if (status === kTimeout) {
      // No need to record this synthetic failure with wpt.fyi.
      this.fail(spec, { name: 'WPT testharness timeout' }, kTimeout);
      // Mark the whole test as TIMEOUT in wpt.fyi report.
      reportResult?.finish('TIMEOUT');
    } else if (status !== kPass) {
      // No need to record this synthetic failure with wpt.fyi.
      this.fail(spec, {
        status: status,
        name: 'WPT test harness error',
        message: harnessStatus.message,
        stack: harnessStatus.stack,
      }, status);
      // Mark the whole test as ERROR in wpt.fyi report.
      reportResult?.finish('ERROR');
    } else {
      reportResult?.finish();
    }
    this.inProgress.delete(spec);
    // Write report incrementally so results survive even if the process
    // is killed before the exit handler runs.
    this.report?.write();
  }

  addTestResult(spec, item) {
    let result = this.results[spec.filename];
    result ||= this.results[spec.filename] = {};
    if (item.status === kSkip) {
      // { filename: { skip: 'reason' } }
      result[kSkip] = item.reason;
    } else {
      // { filename: { fail: { expected: [ ... ],
      //                      unexpected: [ ... ] } }}
      result[item.status] ||= {};
      const key = item.expected ? 'expected' : 'unexpected';
      result[item.status][key] ||= [];
      const hasName = result[item.status][key].includes(item.name);
      if (!hasName) {
        result[item.status][key].push(item.name);
      }
    }
  }

  succeed(test, status, reportResult) {
    //console.log(`[${status.toUpperCase()}] ${test.name}`);
    reportResult?.addSubtest(test.name, 'PASS');
  }

  fail(spec, test, status, reportResult) {
    console.log(`[FAILURE][${status.toUpperCase()}] ${test.name}`);
    if (status === kFail || status === kUncaught) {
      console.log(test.message);
      console.log(test.stack);
    }
    const command = `${process.execPath} ${process.execArgv}` +
                    ` ${require.main?.filename} '${spec.filename}'`; // TODO
    console.log(`Command: ${command}\n`);

    reportResult?.addSubtest(test.name, 'FAIL', test.message);

    this.addTestResult(spec, {
      name: test.name,
      //expected,
      status: kFail,
      reason: test.message || status,
    });
  }

  buildQueue() {
    const queue = [];
    let argFilename;
    let argVariant;
    if (process.argv[3]) {
      ([argFilename, argVariant = ''] = process.argv[3].split('?'));
    }
    for (const spec of this.specs) {
      if (!argFilename) {
        queue.push(spec);
        continue;
      }
      let [filename, variant = ''] = spec.filename.split('?');
      if (filename === argFilename && (!argVariant || variant === argVariant)) {
        queue.push(spec);
      }
    }

    // If the tests are run as `node test/wpt/test-something.js subset.any.js`,
    // only `subset.any.js` (all variants) will be run by the runner.
    // If the tests are run as `node test/wpt/test-something.js 'subset.any.js?1-10'`,
    // only the `?1-10` variant of `subset.any.js` will be run by the runner.
    if (argFilename && queue.length === 0) {
      throw new Error(`${process.argv[3]} not found!`);
    }

    return queue;
  }
}

const runner = new WPTRunner(path.join(__dirname, '..', 'wpt', 'expectation2.json'));

runner.runJsTests();
