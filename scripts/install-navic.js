#!/usr/bin/env node
'use strict';

/**
 * Build Navic and install it on the phone — no APK copying, no file manager.
 * The build is also copied to apps/ so Riff's /store page can serve it.
 *
 * USB:      adb must see the phone (Developer options → USB debugging).
 * Wi-Fi 11+: pair once (Developer options → Wireless debugging → Pair device
 *           with pairing code), then run with `--connect <ip>`.
 * Wi-Fi 9/10: plug in USB once and run with `--wireless` (adb tcpip 5555).
 *
 * Usage:
 *   node scripts/install-navic.js                       # build + install (USB)
 *   node scripts/install-navic.js --connect 192.168.1.5 # build + install over Wi-Fi
 *   node scripts/install-navic.js --wireless            # USB once, then Wi-Fi (Android 9+)
 *   node scripts/install-navic.js --no-build            # install the last build
 *   node scripts/install-navic.js --pair 192.168.1.5:37123 --pair-code 123456
 *
 * Flags:
 *   --app <navic|store>      which app to build/install (default navic)
 *   --connect <host[:port]>  connect to a phone's wireless debugging (default port 5555)
 *   --wireless               switch the USB-connected phone to Wi-Fi adb
 *                            (adb tcpip 5555) and install over the network.
 *                            Needed on Android 9/10, which have no wireless
 *                            debugging pairing dialog.
 *   --pair <host:port>       pair with the phone (use the port/code from the dialog)
 *   --pair-code <code>       the six-digit pairing code
 *   --device <serial>        pick one device when several are attached
 *   --no-build               skip Gradle and install the existing APK
 *   --apk <path>             install a specific APK file
 *   --help                   show this help
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** The apps this script can build: `--app navic` (default) or `--app store`. */
const PROJECTS = {
  navic: {
    name: 'SOPlayer',
    dir: path.join(ROOT, 'Navic'),
    task: 'assembleDefaultDebug',
    apk: path.join(ROOT, 'Navic', 'app', 'build', 'outputs', 'apk', 'default', 'debug', 'Navic.apk'),
  },
  store: {
    name: 'MyApps',
    dir: path.join(ROOT, 'MyApps'),
    task: 'assembleDebug',
    apk: path.join(ROOT, 'MyApps', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
  },
};
const IS_WINDOWS = process.platform === 'win32';

function printHelp() {
  const text = fs.readFileSync(__filename, 'utf8');
  const start = text.indexOf('/**');
  const end = text.indexOf('*/', start);
  const body = text.slice(start + 3, end);
  console.log(body.replace(/^ \* ?/gm, '').trim());
}

function parseArgs(argv) {
  const opts = {
    connect: '',
    wireless: false,
    pair: '',
    pairCode: '',
    device: '',
    app: 'navic',
    build: true,
    apk: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--connect': opts.connect = take(); break;
      case '--wireless': opts.wireless = true; break;
      case '--pair': opts.pair = take(); break;
      case '--pair-code': opts.pairCode = take(); break;
      case '--device': opts.device = take(); break;
      case '--app': opts.app = take(); break;
      case '--apk': opts.apk = take(); break;
      case '--no-build': opts.build = false; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function sdkDir() {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const props = fs.readFileSync(path.join(PROJECTS.navic.dir, 'local.properties'), 'utf8');
    const match = /^sdk\.dir=(.+)$/m.exec(props);
    if (match && fs.existsSync(match[1].trim())) return match[1].trim();
  } catch (_) {}
  const local = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  return fs.existsSync(local) ? local : '';
}

function adbPath() {
  const exe = IS_WINDOWS ? 'adb.exe' : 'adb';
  const sdk = sdkDir();
  if (sdk) {
    const bundled = path.join(sdk, 'platform-tools', exe);
    if (fs.existsSync(bundled)) return bundled;
  }
  return exe; // on PATH
}

function javaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const candidates = IS_WINDOWS
    ? [
      'C:/Program Files/Android/Android Studio/jbr',
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Android Studio', 'jbr'),
    ]
    : [
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
      '/usr/lib/jvm/default-java',
    ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    shell: options.shell === true,
    encoding: 'utf8',
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    if (options.capture) {
      const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
      if (detail) console.error(detail);
    }
    fail(options.errorMessage || `${command} failed (exit ${result.status})`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function buildApk(project) {
  if (!fs.existsSync(project.dir)) fail(`${project.name} folder not found at ${project.dir}`);
  const home = javaHome();
  const sdk = sdkDir();
  const env = Object.assign({}, process.env);
  if (home) env.JAVA_HOME = home;
  if (sdk) env.ANDROID_HOME = sdk;

  console.log(`Building ${project.name}…`);
  // Windows cmd needs the explicit .\ prefix to run a file from the cwd.
  const wrapper = IS_WINDOWS ? '.\\gradlew.bat' : './gradlew';
  run(wrapper, [project.task, '--console=plain'], {
    cwd: project.dir,
    env,
    shell: IS_WINDOWS,
    errorMessage: 'Gradle build failed — fix the compile error above and run again.',
  });
}

const APPS_DIR = path.resolve(__dirname, '..', 'apps');

/** Version name/code recorded by AGP next to the APK. */
function apkVersion(apkPath) {
  const meta = path.join(path.dirname(apkPath), 'output-metadata.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const element = Array.isArray(parsed.elements) ? parsed.elements[0] : parsed;
    if (!element) return '';
    return String(element.versionName || element.versionCode || '').replace(/[^\w.+-]/g, '');
  } catch (_) {
    return '';
  }
}

/**
 * Copy the fresh APK into `apps/`, the folder the LAN page at /store lists, so
 * the phone can also grab it from a browser (Riff → /store).
 */
function publishToStore(apkPath, project) {
  const version = apkVersion(apkPath);
  const target = path.join(APPS_DIR, version ? `${project.name}-${version}.apk` : `${project.name}.apk`);
  try {
    fs.mkdirSync(APPS_DIR, { recursive: true });
    const same = fs.existsSync(target) && fs.statSync(target).size === fs.statSync(apkPath).size;
    if (!same) fs.copyFileSync(apkPath, target);
    console.log(`Store: ${path.relative(path.resolve(__dirname, '..'), target)} — open Riff's /store page on the phone.`);
  } catch (err) {
    console.warn(`Could not publish the APK to apps/: ${err.message}`);
  }
}

function connectedDevices(adb) {
  const output = run(adb, ['devices'], { capture: true });
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && /\sdevice$/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function deviceIp(adb, serial) {
  const shell = (args) => {
    try {
      return run(adb, ['-s', serial, 'shell', ...args], { capture: true });
    } catch (_) {
      return '';
    }
  };
  const route = shell(['ip', 'route']);
  const fromRoute = /src\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(route);
  if (fromRoute) return fromRoute[1];
  const addr = shell(['ip', '-f', 'inet', 'addr', 'show', 'wlan0']);
  const fromAddr = /inet\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(addr);
  return fromAddr ? fromAddr[1] : '';
}

/**
 * Android 9 and 10 have no "wireless debugging" pairing dialog. The older
 * route still works: with the phone on USB, `adb tcpip 5555` restarts adbd on
 * the network, then every later install can go over Wi-Fi until the phone
 * reboots.
 */
function enableWireless(adb, serial) {
  console.log('Switching the phone to Wi-Fi adb (adb tcpip 5555)…');
  run(adb, ['-s', serial, 'tcpip', '5555'], { capture: true });
  const ip = deviceIp(adb, serial);
  if (!ip) {
    fail('Could not read the phone\'s Wi-Fi IP address. Turn Wi-Fi on and run again.');
  }
  // adbd restarts on the phone; give it a moment before connecting.
  sleep(1500);
  return ip;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const project = PROJECTS[opts.app];
  if (!project) fail(`Unknown app "${opts.app}". Use --app ${Object.keys(PROJECTS).join(' or --app ')}.`);

  const adb = adbPath();
  const apk = opts.apk ? path.resolve(opts.apk) : project.apk;

  if (opts.build) {
    buildApk(project);
    publishToStore(apk, project);
  }
  if (!fs.existsSync(apk)) {
    fail(
      `APK not found: ${apk}\n` +
      'Run the script without --no-build, or use ./gradlew :app:assembleDefaultDebug first.'
    );
  }

  run(adb, ['start-server'], { capture: true });

  if (opts.pair) {
    if (!opts.pairCode) {
      fail('--pair needs --pair-code: use the six-digit code from the Wireless debugging dialog.');
    }
    console.log(`Pairing with ${opts.pair}…`);
    run(adb, ['pair', opts.pair, opts.pairCode], {
      errorMessage: 'Pairing failed — make sure the phone is on the "Pair device with pairing code" screen.',
    });
  }

  if (opts.connect) {
    const target = opts.connect.includes(':') ? opts.connect : `${opts.connect}:5555`;
    console.log(`Connecting to ${target}…`);
    const output = run(adb, ['connect', target], { capture: true });
    if (!/connected/i.test(output) || /cannot|failed|could not/i.test(output)) {
      fail(
        `Could not connect to ${target}.\n` +
        'Check that Wireless debugging is on and the pairing/port is current ' +
        '(the port on the Wireless debugging screen changes), then retry.'
      );
    }
  }

  let devices = connectedDevices(adb);
  let networkSerial = '';

  if (opts.device && !devices.includes(opts.device)) {
    fail(`Device ${opts.device} is not connected. Attached: ${devices.join(', ') || 'none'}`);
  }

  if (opts.wireless) {
    const usbList = devices.filter((serial) => !serial.includes(':'));
    const usbSerial = opts.device && !opts.device.includes(':')
      ? opts.device
      : (usbList.length === 1 ? usbList[0] : '');
    if (!usbSerial) {
      fail(
        '--wireless needs the phone on USB first (that is the cable-free step for ' +
        'Android 9/10). Plug it in with USB debugging enabled, then run again.'
      );
    }
    const ip = enableWireless(adb, usbSerial);
    const target = `${ip}:5555`;
    console.log(`Connecting to ${target}…`);
    run(adb, ['connect', target], { capture: true });
    networkSerial = target;
    devices = connectedDevices(adb);
  }

  if (!devices.length) {
    fail(
      'No phone found.\n' +
      'USB: enable Developer options → USB debugging, accept the prompt on the phone.\n' +
      'Android 9/10 over Wi-Fi: plug in USB once and run with "--wireless".\n' +
      'Android 11+: enable Wireless debugging, pair once with ' +
      '"--pair <ip:port> --pair-code <code>", then run with "--connect <ip>".'
    );
  }

  let serial = networkSerial || opts.device;
  if (serial) {
    if (!devices.includes(serial)) {
      fail(`Device ${serial} is not connected. Attached: ${devices.join(', ')}`);
    }
  } else if (devices.length > 1) {
    fail(`Several devices are attached (${devices.join(', ')}). Pick one with --device <serial>.`);
  } else {
    serial = devices[0];
  }

  console.log(`Installing ${path.relative(ROOT, apk)} on ${serial}…`);
  run(adb, ['-s', serial, 'install', '-r', apk], {
    errorMessage:
      'Install failed. If it mentions a signature mismatch, uninstall the app once; ' +
      'otherwise check "Install via USB" in Developer options.',
  });

  console.log('\nDone — SOPlayer is updated. Open it on the phone to use the new build.');
  if (opts.wireless) {
    console.log(`Wi-Fi adb stays on until the phone reboots; after that, plug in once and run --wireless again (or use --connect ${serial}).`);
  } else {
    console.log('Tip: `--no-build` reinstalls the last build without waiting for Gradle.');
  }
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
