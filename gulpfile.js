/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* global require, process */

checkMinVersion();

const $$ = require('gulp-load-plugins')();
const babelify = require('babelify');
const browserify = require('browserify');
const buffer = require('vinyl-buffer');
const colors = require('ansi-colors');
const fs = require('fs-extra');
const gulp = $$.help(require('gulp'));
const lazypipe = require('lazypipe');
const log = require('fancy-log');
const minimatch = require('minimatch');
const minimist = require('minimist');
const path = require('path');
const rimraf = require('rimraf');
const source = require('vinyl-source-stream');
const touch = require('touch');
const watchify = require('watchify');
const wrappers = require('./build-system/compile-wrappers');
const {applyConfig, removeConfig} = require('./build-system/tasks/prepend-global/index.js');
const {cleanupBuildDir, closureCompile} = require('./build-system/tasks/compile');
const {createCtrlcHandler, exitCtrlcHandler} = require('./build-system/ctrlcHandler');
const {createModuleCompatibleES5Bundle} = require('./build-system/tasks/create-module-compatible-es5-bundle');
const {extensionBundles, aliasBundles} = require('./bundles.config');
const {jsifyCssAsync} = require('./build-system/tasks/jsify-css');
const {serve} = require('./build-system/tasks/serve.js');
const {TOKEN: internalRuntimeToken, VERSION: internalRuntimeVersion} = require('./build-system/internal-version') ;
const {transpileTs} = require('./build-system/typescript');

const argv = minimist(
    process.argv.slice(2), {boolean: ['strictBabelTransform']});

require('./build-system/tasks');

const hostname = argv.hostname || 'cdn.ampproject.org';
const hostname3p = argv.hostname3p || '3p.ampproject.net';

// All declared extensions.
const extensions = {};
const extensionAliasFilePath = {};

const {green, red, cyan} = colors;

const minifiedRuntimeTarget = 'dist/v0.js';
const minifiedRuntimeEsmTarget = 'dist/v0-esm.js';
const minified3pTarget = 'dist.3p/current-min/f.js';
const unminifiedRuntimeTarget = 'dist/amp.js';
const unminifiedRuntimeEsmTarget = 'dist/amp-esm.js';
const unminified3pTarget = 'dist.3p/current/integration.js';

const maybeUpdatePackages = process.env.TRAVIS ? [] : ['update-packages'];

extensionBundles.forEach(c => declareExtension(c.name, c.version, c.options));
aliasBundles.forEach(c => {
  declareExtensionVersionAlias(c.name, c.version, c.latestVersion, c.options);
});

/**
 * Tasks that should print the `--nobuild` help text.
 * @private @const {!Set<string>}
 */
const NOBUILD_HELP_TASKS = new Set(['test', 'visual-diff']);

/**
 * Extensions to build when `--extensions=minimal_set`.
 * @private @const {!Array<string>}
 */
const MINIMAL_EXTENSION_SET = [
  'amp-ad',
  'amp-ad-network-adsense-impl',
  'amp-analytics',
  'amp-audio',
  'amp-image-lightbox',
  'amp-lightbox',
  'amp-sidebar',
  'amp-video',
];


/**
 * Extensions that require `amp-video-service` to be built alongside them.
 * @private @const {!Set<string>}
 */
// TODO(alanorozco): Determine dynamically?
const VIDEO_EXTENSIONS = new Set([
  'amp-3q-player',
  'amp-brid-player',
  'amp-dailymotion',
  'amp-gfycat',
  'amp-ima-video',
  'amp-nexxtv-player',
  'amp-ooyala-player',
  'amp-video',
  'amp-wistia-player',
  'amp-youtube',
]);


/**
 * @typedef {{
 *   name: ?string,
 *   version: ?string,
 *   hasCss: ?boolean,
 *   loadPriority: ?string,
 *   cssBinaries: ?Array<string>,
 *   extraGlobs?Array<string>,
 *   bundleOnlyIfListedInFiles: ?boolean
 * }}
 */
const ExtensionOption = {}; // eslint-disable-line no-unused-vars

/**
 * @param {string} name
 * @param {string|!Array<string>} version E.g. 0.1
 * @param {!ExtensionOption} options extension options object.
 */
function declareExtension(name, version, options) {
  const defaultOptions = {hasCss: false};
  const versions = Array.isArray(version) ? version : [version];
  versions.forEach(v => {
    extensions[`${name}-${v}`] =
        Object.assign({name, version: v}, defaultOptions, options);
  });
}

/**
 * This function is used for declaring deprecated extensions. It simply places
 * the current version code in place of the latest versions. This has the
 * ability to break an extension version, so please be sure that this is the
 * correct one to use.
 * @param {string} name
 * @param {string} version E.g. 0.1
 * @param {string} latestVersion
 * @param {!ExtensionOption} options extension options object.
 */
function declareExtensionVersionAlias(name, version, latestVersion, options) {
  extensionAliasFilePath[name + '-' + version + '.js'] = {
    'name': name,
    'file': name + '-' + latestVersion + '.js',
  };
  if (options.hasCss) {
    extensionAliasFilePath[name + '-' + version + '.css'] = {
      'name': name,
      'file': name + '-' + latestVersion + '.css',
    };
  }
  if (options.cssBinaries) {
    options.cssBinaries.forEach(cssBinaryName => {
      extensionAliasFilePath[cssBinaryName + '-' + version + '.css'] = {
        'name': cssBinaryName,
        'file': cssBinaryName + '-' + latestVersion + '.css',
      };
    });
  }
}

/**
 * Stops the timer for the given build step and prints the execution time,
 * unless we are on Travis.
 * @param {string} stepName Name of the action, like 'Compiled' or 'Minified'
 * @param {string} targetName Name of the target, like a filename or path
 * @param {DOMHighResTimeStamp} startTime Start time of build step
 */
function endBuildStep(stepName, targetName, startTime) {
  const endTime = Date.now();
  const executionTime = new Date(endTime - startTime);
  const secs = executionTime.getSeconds();
  const ms = ('000' + executionTime.getMilliseconds().toString()).slice(-3);
  let timeString = '(';
  if (secs === 0) {
    timeString += ms + ' ms)';
  } else {
    timeString += secs + '.' + ms + ' s)';
  }
  if (!process.env.TRAVIS) {
    log(stepName, cyan(targetName), green(timeString));
  }
}

/**
 * Build all the AMP extensions
 *
 * @param {!Object} options
 * @return {!Promise}
 */
function buildExtensions(options) {
  if (!!argv.noextensions && !options.compileAll) {
    return Promise.resolve();
  }

  let extensionsToBuild = [];
  if (!!argv.extensions && !options.compileAll) {
    extensionsToBuild = argv.extensions.split(',');
  }

  const results = [];
  for (const key in extensions) {
    if (extensionsToBuild.length > 0 &&
        extensionsToBuild.indexOf(extensions[key].name) == -1) {
      continue;
    }
    const e = extensions[key];
    let o = Object.assign({}, options);
    o = Object.assign(o, e);
    results.push(buildExtension(e.name, e.version, e.hasCss, o, e.extraGlobs));
  }
  return Promise.all(results);
}

/**
 * Compile the polyfills script and drop it in the build folder
 * @return {!Promise}
 */
function polyfillsForTests() {
  return compileJs('./src/', 'polyfills.js', './build/');
}

/**
 * Compile and optionally minify the stylesheets and the scripts
 * and drop them in the dist folder
 *
 * @param {boolean} watch
 * @param {boolean} shouldMinify
 * @param {boolean=} opt_preventRemoveAndMakeDir
 * @param {boolean=} opt_checkTypes
 * @return {!Promise}
 */
function compile(watch, shouldMinify, opt_preventRemoveAndMakeDir,
  opt_checkTypes) {
  const promises = [
    compileJs('./3p/', 'integration.js',
        './dist.3p/' + (shouldMinify ? internalRuntimeVersion : 'current'), {
          minifiedName: 'f.js',
          checkTypes: opt_checkTypes,
          watch,
          minify: shouldMinify,
          preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
          externs: ['ads/ads.extern.js'],
          include3pDirectories: true,
          includePolyfills: true,
        }),
    compileJs('./3p/', 'ampcontext-lib.js',
        './dist.3p/' + (shouldMinify ? internalRuntimeVersion : 'current'), {
          minifiedName: 'ampcontext-v0.js',
          checkTypes: opt_checkTypes,
          watch,
          minify: shouldMinify,
          preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
          externs: ['ads/ads.extern.js'],
          include3pDirectories: true,
          includePolyfills: false,
        }),
    compileJs('./3p/', 'iframe-transport-client-lib.js',
        './dist.3p/' + (shouldMinify ? internalRuntimeVersion : 'current'), {
          minifiedName: 'iframe-transport-client-v0.js',
          checkTypes: opt_checkTypes,
          watch,
          minify: shouldMinify,
          preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
          externs: ['ads/ads.extern.js'],
          include3pDirectories: true,
          includePolyfills: false,
        }),
    compileJs('./src/', 'amp.js', './dist', {
      toName: 'amp.js',
      minifiedName: 'v0.js',
      includePolyfills: true,
      checkTypes: opt_checkTypes,
      watch,
      preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
      minify: shouldMinify,
      wrapper: wrappers.mainBinary,
      singlePassCompilation: argv.single_pass,
    }),
    compileJs('./extensions/amp-viewer-integration/0.1/examples/',
        'amp-viewer-host.js', './dist/v0/examples', {
          toName: 'amp-viewer-host.max.js',
          minifiedName: 'amp-viewer-host.js',
          incudePolyfills: true,
          watch,
          extraGlobs: ['extensions/amp-viewer-integration/**/*.js'],
          compilationLevel: 'WHITESPACE_ONLY',
          preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
          minify: false,
        }),
  ];

  if (!argv.single_pass) {
    promises.push(
        compileJs('./src/', 'amp.js', './dist', {
          toName: 'amp-esm.js',
          minifiedName: 'v0-esm.js',
          includePolyfills: true,
          includeOnlyESMLevelPolyfills: true,
          checkTypes: opt_checkTypes,
          watch,
          preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
          minify: shouldMinify,
          wrapper: wrappers.mainBinary,
        }));
  }

  // We don't rerun type check for the shadow entry point for now.
  if (!opt_checkTypes) {
    if (!argv.single_pass && (!watch || argv.with_shadow)) {
      promises.push(
          compileJs('./src/', 'amp-shadow.js', './dist', {
            minifiedName: 'shadow-v0.js',
            includePolyfills: true,
            checkTypes: opt_checkTypes,
            watch,
            preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
            minify: shouldMinify,
          })
      );
    }

    if (!watch || argv.with_video_iframe_integration) {
      promises.push(
          compileJs('./src/', 'video-iframe-integration.js', './dist', {
            minifiedName: 'video-iframe-integration-v0.js',
            includePolyfills: false,
            checkTypes: opt_checkTypes,
            watch,
            preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
            minify: shouldMinify,
          }));
    }

    if (!watch || argv.with_inabox) {
      if (!argv.single_pass) {
        promises.push(
            // Entry point for inabox runtime.
            compileJs('./src/inabox/', 'amp-inabox.js', './dist', {
              toName: 'amp-inabox.js',
              minifiedName: 'amp4ads-v0.js',
              includePolyfills: true,
              extraGlobs: ['src/inabox/*.js', '3p/iframe-messaging-client.js'],
              checkTypes: opt_checkTypes,
              watch,
              preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
              minify: shouldMinify,
            }));
      }
      promises.push(

          // inabox-host
          compileJs('./ads/inabox/', 'inabox-host.js', './dist', {
            toName: 'amp-inabox-host.js',
            minifiedName: 'amp4ads-host-v0.js',
            includePolyfills: false,
            checkTypes: opt_checkTypes,
            watch,
            preventRemoveAndMakeDir: opt_preventRemoveAndMakeDir,
            minify: shouldMinify,
          })
      );
    }

    promises.push(
        thirdPartyBootstrap(
            '3p/frame.max.html', 'frame.html', shouldMinify),
        thirdPartyBootstrap(
            '3p/nameframe.max.html', 'nameframe.html',shouldMinify)
    );

    if (watch) {
      $$.watch('3p/nameframe.max.html', function() {
        thirdPartyBootstrap(
            '3p/nameframe.max.html', 'nameframe.html', shouldMinify);
      });
      $$.watch('3p/frame.max.html', function() {
        thirdPartyBootstrap(
            '3p/frame.max.html', 'frame.html', shouldMinify);
      });
    }

    return Promise.all(promises);
  }
}

/**
 * Entry point for 'gulp css'
 * @return {!Promise}
 */
function css() {
  printNobuildHelp();
  return compileCss();
}

const cssEntryPoints = [
  {
    path: 'amp.css',
    outJs: 'css.js',
    outCss: 'v0.css',
  },
  {
    path: 'video-docking.css',
    outJs: 'video-docking.css.js',
    outCss: 'video-docking.css',
  },
  {
    path: 'video-autoplay.css',
    outJs: 'video-autoplay.css.js',
    outCss: 'video-autoplay.css',
  },
];

/**
 * Compile all the css and drop in the build folder
 * @param {boolean} watch
 * @param {boolean=} opt_compileAll
 * @return {!Promise}
 */
function compileCss(watch, opt_compileAll) {
  if (watch) {
    $$.watch('css/**/*.css', function() {
      compileCss();
    });
  }

  /**
   * Writes CSS to build folder
   *
   * @param {string} css
   * @param {string} originalCssFilename
   * @param {string} jsFilename
   * @param {string} cssFilename
   * @return {Promise}
   */
  function writeCss(css, originalCssFilename, jsFilename, cssFilename) {
    return toPromise(gulp.src(`css/${originalCssFilename}`)
        .pipe($$.file(jsFilename, 'export const cssText = ' +
          JSON.stringify(css)))
        .pipe(gulp.dest('build'))
        .on('end', function() {
          mkdirSync('build');
          mkdirSync('build/css');
          fs.writeFileSync(`build/css/${cssFilename}`, css);
        }));
  }

  /**
   * @param {string} path
   * @param {string} outJs
   * @param {string} outCss
   */
  function writeCssEntryPoint(path, outJs, outCss) {
    const startTime = Date.now();

    return jsifyCssAsync(`css/${path}`)
        .then(css => writeCss(css, path, outJs, outCss))
        .then(() => {
          endBuildStep('Recompiled CSS in', path, startTime);
        });
  }

  // Used by `gulp test --local-changes` to map CSS files to JS files.
  fs.writeFileSync('EXTENSIONS_CSS_MAP', JSON.stringify(extensions));


  let promise = Promise.resolve();

  cssEntryPoints.forEach(entryPoint => {
    const {path, outJs, outCss} = entryPoint;
    promise = promise.then(() => writeCssEntryPoint(path, outJs, outCss));
  });

  return promise.then(() => buildExtensions({
    bundleOnlyIfListedInFiles: false,
    compileOnlyCss: true,
    compileAll: opt_compileAll,
  }));
}

/**
 * Copies the css from the build folder to the dist folder
 * @return {!Promise}
 */
function copyCss() {
  const startTime = Date.now();

  cssEntryPoints.forEach(({outCss}) => {
    fs.copySync(`build/css/${outCss}`, `dist/${outCss}`);
  });

  return toPromise(gulp.src('build/css/amp-*.css')
      .pipe(gulp.dest('dist/v0')))
      .then(() => {
        endBuildStep('Copied', 'build/css/*.css to dist/*.css', startTime);
      });
}

/**
 * Copies extensions from
 * extensions/$name/$version/$name.js
 * to
 * dist/v0/$name-$version.js
 *
 * Optionally copies the CSS at extensions/$name/$version/$name.css into
 * a generated JS file that can be required from the extensions as
 * `import {CSS} from '../../../build/$name-0.1.css';`
 *
 * @param {string} name Name of the extension. Must be the sub directory in
 *     the extensions directory and the name of the JS and optional CSS file.
 * @param {string} version Version of the extension. Must be identical to
 *     the sub directory inside the extension directory
 * @param {boolean} hasCss Whether there is a CSS file for this extension.
 * @param {?Object} options
 * @param {!Array=} opt_extraGlobs
 * @return {!Promise}
 */
function buildExtension(name, version, hasCss, options, opt_extraGlobs) {
  options = options || {};
  options.extraGlobs = opt_extraGlobs;
  if (options.compileOnlyCss && !hasCss) {
    return Promise.resolve();
  }
  const path = 'extensions/' + name + '/' + version;
  const jsPath = path + '/' + name + '.js';
  const jsTestPath = path + '/test/test-' + name + '.js';
  if (argv.files && options.bundleOnlyIfListedInFiles) {
    const passedFiles = Array.isArray(argv.files) ? argv.files : [argv.files];
    const shouldBundle = passedFiles.some(glob => {
      return minimatch(jsPath, glob) || minimatch(jsTestPath, glob);
    });
    if (!shouldBundle) {
      return Promise.resolve();
    }
  }
  // Building extensions is a 2 step process because of the renaming
  // and CSS inlining. This watcher watches the original file, copies
  // it to the destination and adds the CSS.
  if (options.watch) {
    // Do not set watchers again when we get called by the watcher.
    const copy = Object.create(options);
    copy.watch = false;
    $$.watch(path + '/*', function() {
      buildExtension(name, version, hasCss, copy);
    });
  }
  let promise = Promise.resolve();
  if (hasCss) {
    mkdirSync('build');
    mkdirSync('build/css');
    const startTime = Date.now();
    promise = buildExtensionCss(path, name, version, options).then(() => {
      endBuildStep('Recompiled CSS in', name, startTime);
    });
    if (options.compileOnlyCss) {
      return promise;
    }
  }
  return promise.then(() => buildExtensionJs(path, name, version, options));
}

/**
 * @param {string} path
 * @param {string} name
 * @param {string} version
 * @param {!Object} options
 */
function buildExtensionCss(path, name, version, options) {
  /**
   * Writes CSS binaries
   *
   * @param {string} name
   * @param {string} css
   */
  function writeCssBinaries(name, css) {
    const jsCss = 'export const CSS = ' + JSON.stringify(css) + ';\n';
    const jsName = `build/${name}.js`;
    const cssName = `build/css/${name}`;
    fs.writeFileSync(jsName, jsCss, 'utf-8');
    fs.writeFileSync(cssName, css, 'utf-8');
  }
  const promises = [];
  const mainCssBinary = jsifyCssAsync(path + '/' + name + '.css')
      .then(writeCssBinaries.bind(null, `${name}-${version}.css`));

  if (Array.isArray(options.cssBinaries)) {
    promises.push.apply(promises, options.cssBinaries.map(function(name) {
      return jsifyCssAsync(`${path}/${name}.css`)
          .then(css => writeCssBinaries(`${name}-${version}.css`, css));
    }));
  }
  promises.push(mainCssBinary);
  return Promise.all(promises);
}

/**
 * Build the JavaScript for the extension specified
 *
 * @param {string} path Path to the extensions directory
 * @param {string} name Name of the extension. Must be the sub directory in
 *     the extensions directory and the name of the JS and optional CSS file.
 * @param {string} version Version of the extension. Must be identical to
 *     the sub directory inside the extension directory
 * @param {!Object} options
 * @return {!Promise}
 */
function buildExtensionJs(path, name, version, options) {
  if (argv.single_pass) {
    console.log('Skipping extension JS build in single pass mode', name);
    return;
  }
  const filename = options.filename || name + '.js';
  return compileJs(path + '/', filename, './dist/v0', Object.assign(options, {
    toName: `${name}-${version}.max.js`,
    minifiedName: `${name}-${version}.js`,
    latestName: `${name}-latest.js`,
    // Wrapper that either registers the extension or schedules it for
    // execution after the main binary comes back.
    // The `function` is wrapped in `()` to avoid lazy parsing it,
    // since it will be immediately executed anyway.
    // See https://github.com/ampproject/amphtml/issues/3977
    wrapper: options.noWrapper ? ''
      : wrappers.extension(name, options.loadPriority),
  }));
}

/**
 * Prints a message that could help speed up local development.
 */
function printNobuildHelp() {
  if (!process.env.TRAVIS) {
    for (const task of NOBUILD_HELP_TASKS) { // eslint-disable-line amphtml-internal/no-for-of-statement
      if (argv._.includes(task)) {
        log(green('To skip building during future'), cyan(task),
            green('runs, use'), cyan('--nobuild'), green('with your'),
            cyan(`gulp ${task}`), green('command.'));
        return;
      }
    }
  }
}

/**
 * Prints a helpful message that lets the developer know how to switch configs.
 * @param {string} command Command being run.
 */
function printConfigHelp(command) {
  if (!process.env.TRAVIS) {
    log(green('Building the runtime for local testing with the'),
        cyan((argv.config === 'canary') ? 'canary' : 'prod'),
        green('AMP config.'));
    log(green('⤷ Use'), cyan('--config={canary|prod}'), green('with your'),
        cyan(command), green('command to specify which config to apply.'));
  }
}

/**
 * Parse the --extensions or the --noextensions flag and
 * prints a helpful message that lets the developer know how to build
 * a list of extensions or without any extensions.
 */
function parseExtensionFlags() {
  if (!process.env.TRAVIS) {
    const noExtensionsMessage = green('⤷ Use ') +
        cyan('--noextensions ') +
        green('to skip building extensions.');
    const extensionsMessage = green('⤷ Use ') +
        cyan('--extensions=amp-foo,amp-bar ') +
        green('to choose which extensions to build.');
    const minimalSetMessage = green('⤷ Use ') +
        cyan('--extensions=minimal_set ') +
        green('to build just the extensions needed to load ') +
        cyan('article.amp.html') + green('.');
    if (argv.extensions) {
      if (typeof (argv.extensions) !== 'string') {
        log(red('ERROR:'), 'Missing list of extensions.');
        log(noExtensionsMessage);
        log(extensionsMessage);
        log(minimalSetMessage);
        process.exit(1);
      }
      argv.extensions = argv.extensions.replace(/\s/g, '');

      if (argv.extensions === 'minimal_set') {
        argv.extensions = MINIMAL_EXTENSION_SET.join(',');
      }

      log(green('Building extension(s):'),
          cyan(argv.extensions.replace(/,/g, ', ')));

      if (maybeAddVideoService()) {
        log(green('⤷ Video component(s) being built, added'),
            cyan('amp-video-service'), green('to extension set.'));
      }
    } else if (argv.noextensions) {
      log(green('Not building any AMP extensions.'));
    } else {
      log(green('Building all AMP extensions.'));
    }
    log(noExtensionsMessage);
    log(extensionsMessage);
    log(minimalSetMessage);
  }
}

/**
 * Adds `amp-video-service` to the extension set if a component requires it.
 * @return {boolean}
 */
function maybeAddVideoService() {
  if (!argv.extensions.split(',').find(ext => VIDEO_EXTENSIONS.has(ext))) {
    return false;
  }
  argv.extensions += ',amp-video-service';
  return true;
}

/**
 * Enables runtime to be used for local testing by writing AMP_CONFIG to file.
 * Called at the end of "gulp build" and "gulp dist --fortesting".
 * @param {string} targetFile File to which the config is to be written.
 */
function enableLocalTesting(targetFile) {
  const config = (argv.config === 'canary') ? 'canary' : 'prod';
  const baseConfigFile =
      'build-system/global-configs/' + config + '-config.json';

  return removeConfig(targetFile).then(() => {
    return applyConfig(
        config, targetFile, baseConfigFile,
        /* opt_localDev */ true, /* opt_localBranch */ true);
  });
}

/**
 * Performs the build steps for gulp build and gulp watch
 * @param {boolean} watch
 * @return {!Promise}
 */
function performBuild(watch) {
  process.env.NODE_ENV = 'development';
  printNobuildHelp();
  printConfigHelp(watch ? 'gulp watch' : 'gulp build');
  parseExtensionFlags();
  return compileCss(watch).then(() => {
    return Promise.all([
      polyfillsForTests(),
      buildAlp({watch}),
      buildExaminer({watch}),
      buildWebWorker({watch}),
      buildExtensions({bundleOnlyIfListedInFiles: !watch, watch}),
      compile(watch),
    ]);
  });
}

/**
 * Enables watching for file changes in css, extensions.
 * @return {!Promise}
 */
function watch() {
  const handlerProcess = createCtrlcHandler('watch');
  return performBuild(true).then(() => exitCtrlcHandler(handlerProcess));
}

/**
 * Main build
 * @return {!Promise}
 */
function build() {
  const handlerProcess = createCtrlcHandler('build');
  return performBuild().then(() => exitCtrlcHandler(handlerProcess));
}

/**
 * Dist Build
 * @return {!Promise}
 */
function dist() {
  const handlerProcess = createCtrlcHandler('dist');
  process.env.NODE_ENV = 'production';
  cleanupBuildDir();
  if (argv.fortesting) {
    printConfigHelp('gulp dist --fortesting');
  }
  parseExtensionFlags();
  return compileCss(/* watch */ undefined, /* opt_compileAll */ true)
      .then(() => {
        return Promise.all([
          compile(false, true, true),
          // NOTE: When adding a line here,
          // consider whether you need to include polyfills
          // and whether you need to init logging (initLogConstructor).
          buildAlp({minify: true, watch: false, preventRemoveAndMakeDir: true}),
          buildExaminer({
            minify: true, watch: false, preventRemoveAndMakeDir: true}),
          buildWebWorker({
            minify: true, watch: false, preventRemoveAndMakeDir: true}),
          buildExtensions({minify: true, preventRemoveAndMakeDir: true}),
          buildExperiments({
            minify: true, watch: false, preventRemoveAndMakeDir: true}),
          buildLoginDone({
            minify: true, watch: false, preventRemoveAndMakeDir: true}),
          buildWebPushPublisherFiles({
            minify: true, watch: false, preventRemoveAndMakeDir: true}),
          copyCss(),
        ]);
      }).then(() => {
        if (process.env.TRAVIS) {
          // New line after all the compilation progress dots on Travis.
          console.log('\n');
        }
      }).then(() => {
        copyAliasExtensions();
      }).then(() => {
        if (argv.fortesting) {
          return enableLocalTesting(minifiedRuntimeTarget).then(() => {
            if (!argv.single_pass) {
              return enableLocalTesting(minifiedRuntimeEsmTarget);
            }
          });
        }
      }).then(() => {
        return createModuleCompatibleES5Bundle('v0.js');
      }).then(() => {
        return createModuleCompatibleES5Bundle('amp4ads-v0.js');
      }).then(() => {
        if (argv.fortesting) {
          return enableLocalTesting(minified3pTarget);
        }
      }).then(() => exitCtrlcHandler(handlerProcess));
}

/**
 * Copy built extension to alias extension
 */
function copyAliasExtensions() {
  if (argv.noextensions) {
    return;
  }
  let extensionsToBuild = [];
  if (!!argv.extensions) {
    extensionsToBuild = argv.extensions.split(',');
  }

  for (const key in extensionAliasFilePath) {
    if (extensionsToBuild.length > 0 &&
        extensionsToBuild.indexOf(extensionAliasFilePath[key]['name']) == -1) {
      continue;
    }
    fs.copySync('dist/v0/' + extensionAliasFilePath[key]['file'],
        'dist/v0/' + key);
  }
}

/**
 * Dedicated type check path.
 * @return {!Promise}
 */
function checkTypes() {
  const handlerProcess = createCtrlcHandler('check-types');
  process.env.NODE_ENV = 'production';
  cleanupBuildDir();
  // Disabled to improve type check performance, since this provides
  // little incremental value.
  /*buildExperiments({
    minify: true,
    checkTypes: true,
    preventRemoveAndMakeDir: true,
  });*/
  const compileSrcs = [
    './src/amp.js',
    './src/amp-shadow.js',
    './src/inabox/amp-inabox.js',
    './ads/alp/install-alp.js',
    './ads/inabox/inabox-host.js',
    './src/web-worker/web-worker.js',
  ];
  const extensionValues = Object.keys(extensions).map(function(key) {
    return extensions[key];
  });
  const extensionSrcs = extensionValues.filter(function(extension) {
    return !extension.noTypeCheck;
  }).map(function(extension) {
    return './extensions/' + extension.name + '/' +
        extension.version + '/' + extension.name + '.js';
  }).sort();
  return compileCss().then(() => {
    return Promise.all([
      closureCompile(compileSrcs.concat(extensionSrcs), './dist',
          'check-types.js', {
            include3pDirectories: true,
            includePolyfills: true,
            extraGlobs: ['src/inabox/*.js'],
            typeCheckOnly: true,
          }),
      // Type check 3p/ads code.
      closureCompile(['./3p/integration.js'], './dist',
          'integration-check-types.js', {
            externs: ['ads/ads.extern.js'],
            include3pDirectories: true,
            includePolyfills: true,
            typeCheckOnly: true,
          }),
      closureCompile(['./3p/ampcontext-lib.js'], './dist',
          'ampcontext-check-types.js', {
            externs: ['ads/ads.extern.js'],
            include3pDirectories: true,
            includePolyfills: true,
            typeCheckOnly: true,
          }),
      closureCompile(['./3p/iframe-transport-client-lib.js'], './dist',
          'iframe-transport-client-check-types.js', {
            externs: ['ads/ads.extern.js'],
            include3pDirectories: true,
            includePolyfills: true,
            typeCheckOnly: true,
          }),
    ]);
  }).then(() => {
    if (process.env.TRAVIS) {
      // New line after all the compilation progress dots on Travis.
      console.log('\n');
    }
  }).then(() => exitCtrlcHandler(handlerProcess));
}

/**
 * Copies frame.html to output folder, replaces js references to minified
 * copies, and generates symlink to it.
 *
 * @param {string} input
 * @param {string} outputName
 * @param {boolean} shouldMinify
 * @return {!Promise}
 */
function thirdPartyBootstrap(input, outputName, shouldMinify) {
  const startTime = Date.now();
  if (!shouldMinify) {
    return toPromise(gulp.src(input)
        .pipe(gulp.dest('dist.3p/current')))
        .then(() => {
          endBuildStep('Processed', input, startTime);
        });
  }

  // By default we use an absolute URL, that is independent of the
  // actual frame host for the JS inside the frame.
  // But during testing we need a relative reference because the
  // version is not available on the absolute path.
  const integrationJs = argv.fortesting
    ? './f.js'
    : `https://${hostname3p}/${internalRuntimeVersion}/f.js`;
  // Convert default relative URL to absolute min URL.
  const html = fs.readFileSync(input, 'utf8')
      .replace(/\.\/integration\.js/g, integrationJs);
  return toPromise($$.file(outputName, html, {src: true})
      .pipe(gulp.dest('dist.3p/' + internalRuntimeVersion))
      .on('end', function() {
        const aliasToLatestBuild = 'dist.3p/current-min';
        if (fs.existsSync(aliasToLatestBuild)) {
          fs.unlinkSync(aliasToLatestBuild);
        }
        fs.symlinkSync(
            './' + internalRuntimeVersion,
            aliasToLatestBuild,
            'dir');
      }))
      .then(() => {
        endBuildStep('Processed', input, startTime);
      });
}

const MODULE_SEPARATOR = ';';
const EXTENSION_BUNDLE_MAP = {
  'amp-viz-vega.js': [
    'third_party/d3/d3.js',
    'third_party/d3-geo-projection/d3-geo-projection.js',
    'third_party/vega/vega.js',
  ],
};

/**
 * Allows (ap|pre)pending to the already compiled, minified JS file
 *
 * @param {string} srcFilename Name of the JS source file
 * @param {string} destFilePath File path to the compiled JS file
 */
function appendToCompiledFile(srcFilename, destFilePath) {
  const bundleFiles = EXTENSION_BUNDLE_MAP[srcFilename];
  if (bundleFiles) {
    const newSource = concatFilesToString(bundleFiles.concat([destFilePath]));
    fs.writeFileSync(destFilePath, newSource, 'utf8');
  }
}

/**
 * Synchronously concatenates the given files into a string.
 *
 * @param {Array<string>} files A list of file paths.
 * @return {string} The concatenated contents of the given files.
 */
function concatFilesToString(files) {
  return files.map(function(filePath) {
    return fs.readFileSync(filePath, 'utf8');
  }).join(MODULE_SEPARATOR);
}

/**
 * Bundles (max) or compiles (min) a given JavaScript file entry point.
 *
 * If `options.typeScript` is true, transpiles from TypeScript into
 * intermediary files before compilation and deletes them afterwards.
 *
 * @param {string} srcDir Path to the src directory
 * @param {string} srcFilename Name of the JS source file
 * @param {string} destDir Destination folder for output script
 * @param {?Object} options
 * @return {!Promise}
 */
function compileJs(srcDir, srcFilename, destDir, options) {
  options = options || {};

  const entryPoint = path.join(srcDir, srcFilename);

  // Transpile TS to Closure-annotated JS before actual bundling or compile.
  if (options.typeScript) {
    const startTime = Date.now();
    transpileTs(srcDir, srcFilename);
    endBuildStep('Transpiled', srcFilename, startTime);
  }

  if (options.minify) {
    const startTime = Date.now();
    return closureCompile(entryPoint, destDir, options.minifiedName, options)
        .then(function() {
          const destPath = path.join(destDir, options.minifiedName);
          appendToCompiledFile(srcFilename, destPath);
          fs.writeFileSync(
              path.join(destDir, 'version.txt'), internalRuntimeVersion);
          if (options.latestName) {
            fs.copySync(
                destPath,
                path.join(destDir, options.latestName));
          }
        })
        .then(() => {
          endBuildStep('Minified', options.minifiedName, startTime);

          // Remove intemediary, transpiled JS files after compilation.
          if (options.typeScript) {
            rimraf.sync(path.join(srcDir, '**/*.js'));
          }
        });
  }

  const startTime = Date.now();
  let bundler = browserify(entryPoint, {debug: true})
      .transform(babelify, {
        compact: false,
        presets: [
          ['env', {
            targets: {
              browsers: ['last 2 versions', 'safari >= 9'],
            },
          }],
        ],
      })
      .once('transform', () => {
        endBuildStep('Transformed', srcFilename, startTime);
      });
  if (options.watch) {
    bundler = watchify(bundler);
  }

  // Default wrapper for `gulp build`.
  // We don't need an explicit function wrapper like we do for `gulp dist`
  // because Babel handles that for you.
  const wrapper = options.wrapper || wrappers.none;

  const lazybuild = lazypipe()
      .pipe(source, srcFilename)
      .pipe(buffer)
      .pipe($$.replace, /\$internalRuntimeVersion\$/g, internalRuntimeVersion)
      .pipe($$.replace, /\$internalRuntimeToken\$/g, internalRuntimeToken)
      .pipe($$.wrap, wrapper)
      .pipe($$.sourcemaps.init.bind($$.sourcemaps), {loadMaps: true});

  const lazywrite = lazypipe()
      .pipe($$.sourcemaps.write.bind($$.sourcemaps), './')
      .pipe(gulp.dest.bind(gulp), destDir);

  const destFilename = options.toName || srcFilename;
  /**
   * Rebundle-javascript
   *
   * @param {boolean} failOnError
   * @return {Promise}
   */
  function rebundle(failOnError) {
    const startTime = Date.now();
    return toPromise(
        bundler.bundle()
            .on('error', function(err) {
              let message = err;
              if (err.stack) {
                // Drop the node_modules call stack, which begins with '    at'.
                message = err.stack.replace(/    at[^]*/, '').trim();
              }
              console.error(red(message));
              if (failOnError) {
                process.exit(1);
              } else {
                endBuildStep('Error while compiling', srcFilename, startTime);
              }
            })
            .pipe(lazybuild())
            .pipe($$.rename(destFilename))
            .pipe(lazywrite())
            .on('end', function() {
              appendToCompiledFile(srcFilename,
                  path.join(destDir, destFilename));

              if (options.latestName) {
                // "amp-foo-latest.js" -> "amp-foo-latest.max.js"
                const latestMaxName =
                    options.latestName.split('.js')[0] + '.max.js';
                // Copy amp-foo-0.1.js to amp-foo-latest.max.js.
                fs.copySync(
                    path.join(destDir, options.toName),
                    path.join(destDir, latestMaxName));
              }
            }))
        .then(() => {
          endBuildStep('Compiled', destFilename, startTime);

          // Remove intemediary, transpiled JS files after compilation.
          if (options.typeScript) {
            rimraf.sync(path.join(srcDir, '**/*.js'));
          }
        })
        .then(() => {
          if (process.env.NODE_ENV === 'development') {
            if (destFilename === 'amp.js') {
              return enableLocalTesting(unminifiedRuntimeTarget);
            } else if (destFilename === 'amp-esm.js') {
              return enableLocalTesting(unminifiedRuntimeEsmTarget);
            } else if (destFilename === 'integration.js') {
              return enableLocalTesting(unminified3pTarget);
            } else {
              return Promise.resolve();
            }
          } else {
            return Promise.resolve();
          }
        });
  }

  if (options.watch) {
    bundler.on('update', function() {
      rebundle(/* failOnError */ false);
      // Touch file in unit test set. This triggers rebundling of tests because
      // karma only considers changes to tests files themselves re-bundle
      // worthy.
      touch('test/_init_tests.js');
    });
  }

  if (options.watch === false) {
    // Due to the two step build process, compileJs() is called twice, once with
    // options.watch set to true and, once with it set to false. However, we do
    // not need to call rebundle() twice. This avoids the duplicate compile seen
    // when you run `gulp watch` and touch a file.
    return Promise.resolve();
  } else {
    // This is the default options.watch === true case, and also covers the
    // `gulp build` / `gulp dist` cases where options.watch is undefined.
    return rebundle(/* failOnError */ true);
  }
}

/**
 * Build all the AMP experiments.html/js.
 *
 * @param {!Object} options
 */
function buildExperiments(options) {
  options = options || {};
  const path = 'tools/experiments';
  const htmlPath = path + '/experiments.html';
  const jsPath = path + '/experiments.js';
  let {watch} = options;
  if (watch === undefined) {
    watch = argv.watch || argv.w;
  }

  // Building extensions is a 2 step process because of the renaming
  // and CSS inlining. This watcher watches the original file, copies
  // it to the destination and adds the CSS.
  if (watch) {
    // Do not set watchers again when we get called by the watcher.
    const copy = Object.create(options);
    copy.watch = false;
    $$.watch(path + '/*', function() {
      buildExperiments(copy);
    });
  }

  // Build HTML.
  const html = fs.readFileSync(htmlPath, 'utf8');
  const minHtml = html.replace('/dist.tools/experiments/experiments.js',
      `https://${hostname}/v0/experiments.js`);
  gulp.src(htmlPath)
      .pipe($$.file('experiments.cdn.html', minHtml))
      .pipe(gulp.dest('dist.tools/experiments/'));

  // Build JS.
  const js = fs.readFileSync(jsPath, 'utf8');
  const builtName = 'experiments.max.js';
  const minifiedName = 'experiments.js';
  return toPromise(gulp.src(path + '/*.js')
      .pipe($$.file(builtName, js))
      .pipe(gulp.dest('build/experiments/')))
      .then(function() {
        return compileJs(
            './build/experiments/', builtName, './dist.tools/experiments/', {
              watch: false,
              minify: options.minify || argv.minify,
              includePolyfills: true,
              minifiedName,
              preventRemoveAndMakeDir: options.preventRemoveAndMakeDir,
              checkTypes: options.checkTypes,
            });
      });
}


/**
 * Build amp-web-push publisher files HTML page.
 *
 * @param {!Object} options
 */
function buildWebPushPublisherFiles(options) {
  return buildWebPushPublisherFilesVersion('0.1', options);
}


/**
 * Build amp-web-push publisher files HTML page.
 *
 * @param {string} version
 * @param {!Object} options
 */
function buildWebPushPublisherFilesVersion(version, options) {
  options = options || {};
  const {watch} = options;
  const fileNames =
      ['amp-web-push-helper-frame', 'amp-web-push-permission-dialog'];
  const promises = [];

  mkdirSync('dist');
  mkdirSync('dist/v0');

  for (let i = 0; i < fileNames.length; i++) {
    const fileName = fileNames[i];
    promises.push(buildWebPushPublisherFile(version, fileName, watch, options));
  }

  return Promise.all(promises);
}

/**
 * Build WebPushPublisher file
 *
 * @param {*} version
 * @param {string} fileName
 * @param {string} watch
 * @param {Object} options
 * @return {Promise}
 */
function buildWebPushPublisherFile(version, fileName, watch, options) {
  const basePath = `extensions/amp-web-push/${version}/`;
  const tempBuildDir = `build/all/amp-web-push-${version}/`;
  const distDir = 'dist/v0';

  // Build Helper Frame JS
  const js = fs.readFileSync(basePath + fileName + '.js', 'utf8');
  const builtName = fileName + '.js';
  const minifiedName = fileName + '.js';
  return toPromise(gulp.src(basePath + '/*.js')
      .pipe($$.file(builtName, js))
      .pipe(gulp.dest(tempBuildDir)))
      .then(function() {
        return compileJs('./' + tempBuildDir, builtName, './' + distDir, {
          watch,
          includePolyfills: true,
          minify: options.minify || argv.minify,
          minifiedName,
          preventRemoveAndMakeDir: options.preventRemoveAndMakeDir,
          extraGlobs: [
            tempBuildDir + '*.js',
          ],
        });
      })
      .then(function() {
        if (fs.existsSync(distDir + '/' + minifiedName)) {
          // Build Helper Frame HTML
          let fileContents =
              fs.readFileSync(basePath + fileName + '.html', 'utf8');
          fileContents = fileContents.replace(
              '<!-- [GULP-MAGIC-REPLACE ' + fileName + '.js] -->',
              '<script>' + fs.readFileSync(distDir + '/' +
              minifiedName, 'utf8') + '</script>'
          );

          fs.writeFileSync('dist/v0/' + fileName + '.html',
              fileContents);
        }
      });
}

/**
 * Build "Login Done" page.
 *
 * @param {!Object} options
 */
function buildLoginDone(options) {
  return buildLoginDoneVersion('0.1', options);
}

/**
 * Build "Login Done" page for the specified version.
 *
 * @param {string} version
 * @param {!Object} options
 */
function buildLoginDoneVersion(version, options) {
  options = options || {};
  const path = `extensions/amp-access/${version}/`;
  const buildDir = `build/all/amp-access-${version}/`;
  const htmlPath = path + 'amp-login-done.html';
  const jsPath = path + 'amp-login-done.js';
  let {watch} = options;
  if (watch === undefined) {
    watch = argv.watch || argv.w;
  }

  // Building extensions is a 2 step process because of the renaming
  // and CSS inlining. This watcher watches the original file, copies
  // it to the destination and adds the CSS.
  if (watch) {
    // Do not set watchers again when we get called by the watcher.
    const copy = Object.create(options);
    copy.watch = false;
    $$.watch(path + '/*', function() {
      buildLoginDoneVersion(version, copy);
    });
  }

  // Build HTML.
  const html = fs.readFileSync(htmlPath, 'utf8');
  const minJs = `https://${hostname}/v0/amp-login-done-${version}.js`;
  const minHtml = html
      .replace(
          `../../../dist/v0/amp-login-done-${version}.max.js`,
          minJs)
      .replace(
          `../../../dist/v0/amp-login-done-${version}.js`,
          minJs);
  if (minHtml.indexOf(minJs) == -1) {
    throw new Error('Failed to correctly set JS in login-done.html');
  }

  mkdirSync('dist');
  mkdirSync('dist/v0');

  fs.writeFileSync('dist/v0/amp-login-done-' + version + '.html',
      minHtml);

  // Build JS.
  const js = fs.readFileSync(jsPath, 'utf8');
  const builtName = 'amp-login-done-' + version + '.max.js';
  const minifiedName = 'amp-login-done-' + version + '.js';
  const latestName = 'amp-login-done-latest.js';
  return toPromise(gulp.src(path + '/*.js')
      .pipe($$.file(builtName, js))
      .pipe(gulp.dest(buildDir)))
      .then(function() {
        return compileJs('./' + buildDir, builtName, './dist/v0/', {
          watch: false,
          includePolyfills: true,
          minify: options.minify || argv.minify,
          minifiedName,
          preventRemoveAndMakeDir: options.preventRemoveAndMakeDir,
          latestName,
          extraGlobs: [
            buildDir + 'amp-login-done-0.1.max.js',
            buildDir + 'amp-login-done-dialog.js',
          ],
        });
      });
}

/**
 * Build "Iframe API".
 *
 * @param {!Object} options
 */
function buildAccessIframeApi(options) {
  const version = '0.1';
  options = options || {};
  const path = `extensions/amp-access/${version}/iframe-api`;
  let {watch} = options;
  if (watch === undefined) {
    watch = argv.watch || argv.w;
  }
  const minify = options.minify || argv.minify;
  mkdirSync('dist.3p');
  mkdirSync('dist.3p/current');
  return compileJs(path + '/', 'amp-iframe-api-export.js',
      './dist.3p/current', {
        minifiedName: 'amp-iframe-api-v0.js',
        checkTypes: options.checkTypes || argv.checkTypes,
        watch,
        minify,
        preventRemoveAndMakeDir: options.preventRemoveAndMakeDir,
        include3pDirectories: false,
        includePolyfills: true,
      });
}

/**
 * Build ALP JS.
 *
 * @param {!Object} options
 */
function buildAlp(options) {
  options = options || {};
  return compileJs('./ads/alp/', 'install-alp.js', './dist/', {
    toName: 'alp.max.js',
    watch: options.watch,
    minify: options.minify || argv.minify,
    includePolyfills: true,
    minifiedName: 'alp.js',
    preventRemoveAndMakeDir: options.preventRemoveAndMakeDir,
  });
}

/**
 * Build Examiner JS.
 *
 * @param {!Object} options
 */
function buildExaminer(options) {
  options = options || {};
  return compileJs('./src/examiner/', 'examiner.js', './dist/', {
    toName: 'examiner.max.js',
    watch: options.watch,
    minify: options.minify || argv.minify,
    includePolyfills: true,
    minifiedName: 'examiner.js',
    preventRemoveAndMakeDir: options.preventRemoveAndMakeDir,
  });
}

/**
 * Build web worker JS.
 *
 * @param {!Object} options
 */
function buildWebWorker(options) {
  const opts = Object.assign({}, options);
  return compileJs('./src/web-worker/', 'web-worker.js', './dist/', {
    toName: 'ww.max.js',
    minifiedName: 'ww.js',
    includePolyfills: true,
    watch: opts.watch,
    minify: opts.minify || argv.minify,
    preventRemoveAndMakeDir: opts.preventRemoveAndMakeDir,
  });
}

/**
 * Exits the process if gulp is running with a node version lower than
 * the required version. This has to run very early to avoid parse
 * errors from modules that e.g. use let.
 */
function checkMinVersion() {
  const majorVersion = Number(process.version.replace(/v/, '').split('.')[0]);
  if (majorVersion < 4) {
    log('Please run AMP with node.js version 4 or newer.');
    log('Your version is', process.version);
    process.exit(1);
  }
}

/**
 *Creates directory in sync manner
 *
 * @param {string} path
 */
function mkdirSync(path) {
  try {
    fs.mkdirSync(path);
  } catch (e) {
    if (e.code != 'EEXIST') {
      throw e;
    }
  }
}

/**
 * Returns a promise for readable
 *
 * @param {*} readable
 * @return {Promise}
 */
function toPromise(readable) {
  return new Promise(function(resolve, reject) {
    readable.on('error', reject).on('end', resolve);
  });
}

/* eslint "google-camelcase/google-camelcase": 0 */

/**
 * Gulp tasks
 */
gulp.task('build', 'Builds the AMP library', maybeUpdatePackages, build, {
  options: {
    config: '  Sets the runtime\'s AMP_CONFIG to one of "prod" or "canary"',
    extensions: '  Builds only the listed extensions.',
    noextensions: '  Builds with no extensions.',
  },
});
gulp.task('check-all', 'Run through all presubmit checks',
    ['lint', 'dep-check', 'check-types', 'presubmit']);
gulp.task('check-types', 'Check JS types', maybeUpdatePackages, checkTypes);
gulp.task('css', 'Recompile css to build directory', maybeUpdatePackages, css);
gulp.task('default', 'Runs "watch" and then "serve"',
    maybeUpdatePackages.concat(['watch']), serve, {
      options: {
        extensions: '  Watches and builds only the listed extensions.',
        noextensions: '  Watches and builds with no extensions.',
      },
    });
gulp.task('dist', 'Build production binaries', maybeUpdatePackages, dist, {
  options: {
    pseudo_names: '  Compiles with readable names. ' +
            'Great for profiling and debugging production code.',
    fortesting: '  Compiles production binaries for local testing',
    config: '  Sets the runtime\'s AMP_CONFIG to one of "prod" or "canary"',
    single_pass: 'Compile AMP\'s primary JS bundles in a single invocatoion',
  },
});
gulp.task('watch', 'Watches for changes in files, re-builds when detected',
    maybeUpdatePackages, watch, {
      options: {
        with_inabox: '  Also watch and build the amp-inabox.js binary.',
        with_shadow: '  Also watch and build the amp-shadow.js binary.',
        extensions: '  Watches and builds only the listed extensions.',
        noextensions: '  Watches and builds with no extensions.',
      },
    });
gulp.task('build-experiments', 'Builds experiments.html/js', buildExperiments);
gulp.task('build-login-done', 'Builds login-done.html/js', buildLoginDone);
gulp.task('build-access-iframe-api', 'Builds iframe-api.js',
    buildAccessIframeApi);
