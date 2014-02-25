/*
*********************************************************************************************

  Loader Polyfill

    - Implemented exactly to the 2013-12-02 Specification Draft -
      https://github.com/jorendorff/js-loaders/blob/e60d3651/specs/es6-modules-2013-12-02.pdf
      with the only exceptions as described here

    - Abstract functions have been combined where possible, and their associated functions 
      commented

    - Declarative Module Support is entirely disabled, and an error will be thrown if 
      the instantiate loader hook returns undefined

    - With this assumption, instead of Link, LinkDynamicModules is run directly

    - ES6 support is thus provided through the translate function of the System loader

    - EnsureEvaluated is removed, but may in future implement dynamic execution pending 
      issue - https://github.com/jorendorff/js-loaders/issues/63

    - Realm implementation is entirely omitted. As such, Loader.global and Loader.realm
      accessors will throw errors, as well as Loader.eval

    - Loader module table iteration currently not yet implemented

*********************************************************************************************
*/

// Some Helpers

// logs a linkset snapshot for debugging
/* function snapshot(loader) {
  console.log('\n');
  for (var i = 0; i < loader._loads.length; i++) {
    var load = loader._loads[i];
    var linkSetLog = load.name + ' (' + load.status + '): ';

    for (var j = 0; j < load.linkSets.length; j++) {
      linkSetLog += '{'
      linkSetLog += logloads(load.linkSets[j].loads);
      linkSetLog += '} ';
    }
    console.log(linkSetLog);
  }
  console.log('\n');
}
function logloads(loads) {
  var log = '';
  for (var k = 0; k < loads.length; k++)
    log += loads[k].name + (k != loads.length - 1 ? ' ' : '');
  return log;
} */

(function (global) {
  var Module = global.Module || require('./module.js');
  var Promise = global.Promise || require('./promise.js');

  var defineProperty;
  try {
    if (!!Object.defineProperty({}, 'a', {})) {
      defineProperty = Object.defineProperty;
    }
  } catch (e) {
    defineProperty = function (obj, prop, opt) {
      try {
        obj[prop] = opt.get.call(obj);
      } catch (_) {
        obj[prop] = opt.value;
      }
    };
  }

  function assert(name, expression) {
    if (!expression)
      console.log('Assertion Failed - ' + name);
  }
  function preventExtensions(obj) {
    if (Object.preventExtensions)
      Object.preventExtensions(obj);
  }

  // Define an IE-friendly shim good-enough for purposes
  var indexOf = Array.prototype.indexOf || function (item) { 
    for (var i = 0, thisLen = this.length; i < thisLen; i++) {
      if (this[i] === item) {
        return i;
      }
    }
    return -1;
  };

  // Load Abstract Functions

  function createLoad(name) {
    return {
      status: 'loading',
      name: name,
      metadata: {},
      linkSets: []
    };
  }

  // promise for a load record, can be in registry, already loading, or not
  function requestLoad(loader, request, refererName, refererAddress) {
    return new Promise(function(resolve, reject) {
      // CallNormalize
      resolve(loader.normalize(request, refererName, refererAddress));
    })

    // GetOrCreateLoad
    .then(function(name) {
      var load;
      if (loader._modules[name]) {
        load = createLoad(name);
        load.status = 'linked';
        return load;
      }

      for (var i = 0, l = loader._loads.length; i < l; i++) {
        load = loader._loads[i];
        if (load.name == name) {
          assert('loading or loaded', load.status == 'loading' || load.status == 'loaded');
          return load;
        }
      }

      // CreateLoad
      load = createLoad(name);
      loader._loads.push(load);

      proceedToLocate(loader, load);

      return load;
    });
  }
  function proceedToLocate(loader, load) {
    proceedToFetch(loader, load,
      Promise.resolve()
      // CallLocate
      .then(function() {
        return loader.locate({ name: load.name, metadata: load.metadata });
      })
    );
  }
  function proceedToFetch(loader, load, p) {
    proceedToTranslate(loader, load, 
      p
      // CallFetch
      .then(function(address) {
        if (load.status == 'failed') // NB https://github.com/jorendorff/js-loaders/issues/88
          return undefined;
        load.address = address;
        return loader.fetch({ name: load.name, metadata: load.metadata, address: address });
      })
    );
  }
  function proceedToTranslate(loader, load, p) {
    p
    // CallTranslate
    .then(function(source) {
      if (load.status == 'failed')
        return undefined;
      return loader.translate({ name: load.name, metadata: load.metadata, address: load.address, source: source })
    })

    // CallInstantiate
    .then(function(source) {
      if (load.status == 'failed')
        return undefined;
      load.source = source;
      return loader.instantiate({ name: load.name, metadata: load.metadata, address: load.address, source: source });
    })

    // InstantiateSucceeded
    .then(function(instantiateResult) {
      if (load.status == 'failed')
        return undefined;

      var depsList;
      if (instantiateResult === undefined)
        throw 'Declarative parsing is not implemented by the polyfill.';

      else if (typeof instantiateResult == 'object') {
        depsList = instantiateResult.deps || [];
        load.execute = instantiateResult.execute;
        load.kind = 'dynamic';
      }
      else
        throw TypeError('Invalid instantiate return value');

      // ProcessLoadDependencies
      load.dependencies = {};
      load.depsList = depsList;
      var loadPromises = [];
      for (var i = 0, l = depsList.length; i < l; i++) (function(request) {
        var p = requestLoad(loader, request, load.name, load.address);

        // AddDependencyLoad (load is parentLoad)
        p.then(function(depLoad) {
          assert('not already a dependency', !load.dependencies[request]);
          load.dependencies[request] = depLoad.name;

          if (depLoad.status != 'linked') {
            var linkSets = load.linkSets.concat([]);
            for (var i = 0, l = linkSets.length; i < l; i++)
              addLoadToLinkSet(linkSets[i], depLoad);
          }
        });

        loadPromises.push(p);
      })(depsList[i]);

      return Promise.all(loadPromises);
    })

    // LoadSucceeded
    .then(function() {
      assert('is loading', load.status == 'loading');

      load.status = 'loaded';

      // console.log('load succeeeded ' + load.name);
      // snapshot(loader);

      var linkSets = load.linkSets.concat([]);
      for (var i = 0, l = linkSets.length; i < l; i++)
        updateLinkSetOnLoad(linkSets[i], load);
    }

    // LoadFailed
    , function(exc) {
      assert('is loading on fail', load.status == 'loading');
      load.status = 'failed';
      load.exception = exc;
      for (var i = 0, l = load.linkSets.length; i < l; i++)
        linkSetFailed(load.linkSets[i], exc);
      assert('fail linkSets removed', load.linkSets.length == 0);
    });
  }


  // LinkSet Abstract Functions
  function createLinkSet(loader, startingLoad) {
    var resolve, reject, promise = new Promise(function(_resolve, _reject) { resolve = _resolve; reject = _reject; });
    var linkSet = {
      loader: loader,
      loads: [],
      done: promise,
      resolve: resolve,
      reject: reject,
      loadingCount: 0
    };
    addLoadToLinkSet(linkSet, startingLoad);
    return linkSet;
  }
  function addLoadToLinkSet(linkSet, load) {
    assert('loading or loaded on link set', load.status == 'loading' || load.status == 'loaded');

    for (var i = 0, l = linkSet.loads.length; i < l; i++)
      if (linkSet.loads[i] == load)
        return;

    linkSet.loads.push(load);
    load.linkSets.push(linkSet);

    if (load.status != 'loaded')
      linkSet.loadingCount++;

    var loader = linkSet.loader;

    for (var dep in load.dependencies) {
      var name = load.dependencies[dep];

      if (loader._modules[name])
        continue;

      for (var i = 0, l = loader._loads.length; i < l; i++)
        if (loader._loads[i].name == name) {
          addLoadToLinkSet(linkSet, loader._loads[i]);
          break;
        }
    }
    // console.log('add to linkset ' + load.name);
    // snapshot(linkSet.loader);
  }
  function updateLinkSetOnLoad(linkSet, load) {
    // NB https://github.com/jorendorff/js-loaders/issues/85
    // assert('no load when updated ' + load.name, indexOf.call(linkSet.loads, load) != -1);
    assert('loaded or linked', load.status == 'loaded' || load.status == 'linked');

    // console.log('update linkset on load ' + load.name);
    // snapshot(linkSet.loader);

    // see https://github.com/jorendorff/js-loaders/issues/80
    linkSet.loadingCount--;
    /* for (var i = 0; i < linkSet.loads.length; i++) {
      if (linkSet.loads[i].status == 'loading') {
        return;
      }
    } */

    if (linkSet.loadingCount > 0)
      return;

    var startingLoad = linkSet.loads[0];
    try {
      link(linkSet.loads, linkSet.loader);
    }
    catch(exc) {
      return linkSetFailed(linkSet, exc);
    }

    assert('loads cleared', linkSet.loads.length == 0);
    linkSet.resolve(startingLoad);
  }
  function linkSetFailed(linkSet, exc) {
    var loads = linkSet.loads.concat([]);
    for (var i = 0, l = loads.length; i < l; i++) {
      var load = loads[i];
      var linkIndex = indexOf.call(load.linkSets, linkSet);
      assert('link not present', linkIndex != -1);
      load.linkSets.splice(linkIndex, 1);
      if (load.linkSets.length == 0) {
        var globalLoadsIndex = indexOf.call(linkSet.loader._loads, load);
        if (globalLoadsIndex != -1)
          linkSet.loader._loads.splice(globalLoadsIndex, 1);
      }
    }
    linkSet.reject(exc);
  }
  function finishLoad(loader, load) {
    // if not anonymous, add to the module table
    if (load.name) {
      assert('load not in module table', !loader._modules[load.name]);
      loader._modules[load.name] = load.module;
    }
    var loadIndex = indexOf.call(loader._loads, load);
    if (loadIndex != -1)
      loader._loads.splice(loadIndex, 1);
    for (var i = 0, l = load.linkSets.length; i < l; i++) {
      loadIndex = indexOf.call(load.linkSets[i].loads, load);
      load.linkSets[i].loads.splice(loadIndex, 1);
    }
    load.linkSets = [];
  }
  function loadModule(loader, name, options) {
    return new Promise(asyncStartLoadPartwayThrough(loader, name, options && options.address ? 'fetch' : 'locate', undefined, options && options.address, undefined)).then(function(load) {
      return load;
    });
  }
  function asyncStartLoadPartwayThrough(loader, name, step, meta, address, source) {
    return function(resolve, reject) {
      if (loader._modules[name])
        throw new TypeError('Module "' + name + '" already exists in the module table');
      for (var i = 0, l = loader._loads.length; i < l; i++)
        if (loader._loads[i].name == name)
          throw new TypeError('Module "' + name + '" is already loading');

      var load = createLoad(name);

      if (meta)
        load.metadata = meta;

      var linkSet = createLinkSet(loader, load);

      loader._loads.push(load);

      // NB spec change as in https://github.com/jorendorff/js-loaders/issues/79
      linkSet.done.then(resolve, reject);

      if (step == 'locate')
        proceedToLocate(loader, load);

      else if (step == 'fetch')
        proceedToFetch(loader, load, Promise.resolve(address));

      else {
        assert('translate step', step == 'translate');
        load.address = address;
        proceedToTranslate(loader, load, Promise.resolve(source));
      }
    }
  }
  function evaluateLoadedModule(loader, load) {
    assert('is linked ' + load.name, load.status == 'linked');

    assert('is a module', load.module instanceof Module);

    // ensureEvaluated(load.module, [], loader);

    return load.module;
  }

  // Linking
  // Link is directly LinkDynamicModules assuming all modules are dynamic
  function link(loads, loader) {
    // console.log('linking {' + logloads(loads) + '}');

    // continue until all linked
    // NB circular dependencies will stall this loop
    var loopCnt = 0;
    while (loads.length) {
      loopCnt++;
      // search through to find a load with all its dependencies linked
      search: for (var i = 0; i < loads.length; i++) {
        var load = loads[i];
        var depNames = [];
        for (var d in load.dependencies) {
          var depName = load.dependencies[d];
          // being in the module table means it is linked
          if (!loader._modules[depName])
            continue search;
          var index = load.depsList.indexOf(d);
          depNames[index] = depName;
        }

        // all dependencies linked now, so we can execute
        var module = load.execute.apply(null, depNames);
        if (!(module instanceof Module))
          throw new TypeError('Execution must define a Module instance');
        load.module = module;
        load.status = 'linked';
        finishLoad(loader, load);
      }
      if (loopCnt === 1000) {
        console.log('Circular Dependency Detected');
        return;
      }
    }
    // console.log('linked');
  }

  // Loader
  function Loader(options) {
    if (typeof options != 'object')
      throw new TypeError('Options must be an object');

    if (options.normalize)
      this.normalize = options.normalize;
    if (options.locate)
      this.locate = options.locate;
    if (options.fetch)
      this.fetch = options.fetch;
    if (options.translate)
      this.translate = options.translate;
    if (options.instantiate)
      this.instantiate = options.instantiate;

    defineProperty(this, 'global', {
      get: function() {
        throw new TypeError('global accessor not provided by polyfill');
      }
    });
    defineProperty(this, 'realm', {
      get: function() {
        throw new TypeError('Realms not implemented in polyfill');
      }
    });

    this._modules = {};
    this._loads = [];
  }

  // NB importPromises hacks ability to import a module twice without error - https://github.com/jorendorff/js-loaders/issues/60
  var importPromises = {};
  Loader.prototype = {
    define: function(name, source, options) {
      if (importPromises[name])
        throw new TypeError('Module is already loading.');
      importPromises[name] = new Promise(asyncStartLoadPartwayThrough(this, name, options && options.address ? 'fetch' : 'translate', options && options.meta || {}, options && options.address, source));
      return importPromises[name].then(function() { delete importPromises[name]; });
    },
    load: function(request, options) {
      if (this._modules[request])
        return Promise.resolve(this._modules[request]);
      if (importPromises[request])
        return importPromises[request];
      importPromises[request] = loadModule(this, request, options);
      return importPromises[request].then(function() { delete importPromises[request]; })
    },
    module: function(source, options) {
      var load = createLoad();
      load.address = options && options.address;
      var linkSet = createLinkSet(this, load);
      var sourcePromise = Promise.resolve(source);
      var p = linkSet.done.then(function() {
        evaluateLoadedModule(this, load);
      });
      proceedToTranslate(this, load, sourcePromise);
      return p;
    },
    'import': function(name, options) {
      if (this._modules[name])
        return Promise.resolve(this._modules[name]);
      return (importPromises[name] || (importPromises[name] = loadModule(this, name, options)))
        .then(function(load) {
          delete importPromises[name];
          return evaluateLoadedModule(this, load);
        });
    },
    eval: function(source) {
      throw new TypeError('Eval not implemented in polyfill')
    },
    get: function(key) {
      // NB run ensure evaluted here when implemented
      return this._modules[key];
    },
    has: function(name) {
      return !!this._modules[name];
    },
    set: function(name, module) {
      if (!(module instanceof Module))
        throw new TypeError('Set must be a module');
      this._modules[name] = module;
    },
    'delete': function(name) {
      return this._modules[name] ? delete this._modules[name] : false;
    },
    // NB implement iterations
    entries: function() {
      throw new TypeError('Iteration not yet implemented in the polyfill');
    },
    keys: function() {
      throw new TypeError('Iteration not yet implemented in the polyfill');
    },
    values: function() {
      throw new TypeError('Iteration not yet implemented in the polyfill');
    },
    normalize: function(name, refererName, refererAddress) {
      return name;
    },
    locate: function(load) {
      return load.name;
    },
    fetch: function(load) {
      throw new TypeError('Fetch not implemented');
    },
    translate: function(load) {
      return load.source;
    },
    instantiate: function(load) {
    }
  };

  if (typeof exports === 'object') {
    module.exports = Loader;
  }

  global.Loader || (global.Loader = Loader);
  global.LoaderPolyfill = Loader;

})(typeof global !== 'undefined' ? global : this);
