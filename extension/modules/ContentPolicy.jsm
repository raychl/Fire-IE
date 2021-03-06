/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 * The Original Code is Adblock Plus.
 *
 * The Initial Developer of the Original Code is
 * Wladimir Palant.
 * Portions created by the Initial Developer are Copyright (C) 2006-2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Yuan Xulei(hi@yxl.name)
 */

/**
 * @fileOverview Content policy implementation, responsible for automatic engine switching.
 */

var EXPORTED_SYMBOLS = ["Policy"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

let baseURL = Cc["@fireie.org/fireie/private;1"].getService(Ci.nsIURI);

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");

Cu.import(baseURL.spec + "Utils.jsm");
Cu.import(baseURL.spec + "Prefs.jsm");
Cu.import(baseURL.spec + "RuleStorage.jsm");
Cu.import(baseURL.spec + "RuleClasses.jsm");
Cu.import(baseURL.spec + "Matcher.jsm");
Cu.import(baseURL.spec + "UtilsPluginManager.jsm");

/**
 * Public policy checking functions and auxiliary objects
 * @class
 */
var Policy = {

  /**
   * Map containing all schemes that should be ignored by content policy.
   * @type Object
   */
  ignoredSchemes: {},

  /**
   * Called on module startup.
   */
  startup: function()
  {
    for each(var scheme in Prefs.contentPolicy_ignoredSchemes.toLowerCase().split(" "))
    {
      Policy.ignoredSchemes[scheme] = true;
    }

    // Register our content policy
    let registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    try
    {
      registrar.registerFactory(PolicyPrivate.classID, PolicyPrivate.classDescription, PolicyPrivate.contractID, PolicyPrivate);
    }
    catch (e)
    {
      // Don't stop on errors - the factory might already be registered
      Utils.ERROR(e);
    }

    let catMan = Utils.categoryManager;
    for each(let category in PolicyPrivate.xpcom_categories)
    catMan.addCategoryEntry(category, PolicyPrivate.classDescription, PolicyPrivate.contractID, false, true);

    Services.obs.addObserver(PolicyPrivate, "http-on-modify-request", true);
  },

  shutdown: function()
  {
    Services.obs.removeObserver(PolicyPrivate, "http-on-modify-request");
  },

  /**
   * Checks whether the page should be loaded in IE engine. 
   * @param {String} url
   * @return {Boolean} true if IE engine should be used.
   */
  checkEngineRule: function(url)
  {
    if (Utils.isFirefoxOnly(url)) return false;
    let docDomain = Utils.getHostname(url);
    let match = EngineMatcher.matchesAny(url, docDomain);
    if (match)
    {
      RuleStorage.increaseHitCount(match);
    }
    if (!match) return Prefs.autoSwitchOnRuleMiss === "ie";
    return match instanceof EngineRule;
  },

  /**
   * Checks whether the page should be loaded in Firefox engine. 
   * @param {String} url
   * @return {Boolean} true if Firefox engine should be used.
   */
  checkEngineExceptionalRule: function(url)
  {
    // It's a security risk to allow IE engine switch back to
    // pages with chrome privilege.
    if (Utils.urlHasChromePrivilege(url))
      return false;
    
    let docDomain = Utils.getHostname(url);
    let match = EngineMatcher.matchesAny(url, docDomain);
    // While explicitly checking against exceptional rules,
    // don't count hits as we'll hit the exceptional rule again
    // after switch back.
    if (!match) return Prefs.autoSwitchOnRuleMiss === "fx";
    return Prefs.autoSwitchOnExceptionalRuleHit === "fx" &&
           match instanceof EngineExceptionalRule;
  },

  /**
   * Checks whether IE user agent should be used. 
   * @param {String} url
   * @return {UserAgentRule} the rule if there's any match
   */
  checkUserAgentRule: function(url, domain)
  {
    let match = UserAgentMatcher.matchesAny(url, domain);
    if (match)
    {
      RuleStorage.increaseHitCount(match);
    }
    return match instanceof UserAgentRule ? match : null;
  },

  /**
   * Checks whether the engine of given location's scheme is switchable.
   * @param {nsIURI} location  
   * @return {Boolean}
   */
  isSwitchableScheme: function(location)
  {
    return !(location.scheme in Policy.ignoredSchemes);
  },
  
  /**
   * Checks whether user has manually switched engine on current tab & url
   * @param {nsIDOMNode} browserNode
   * @param {String} url
   * @return {Boolean}
   */
  isManuallySwitched: function(browserNode, url)
  {
    let hostName = Utils.getEffectiveHost(url) || "";
    return browserNode.hasAttribute("manuallySwitched")
        && browserNode.getAttribute("manuallySwitched") == hostName;
  },
  
  /**
   * Sets the manually switched flag on current tab & url
   * @param {nsIDOMNode} browserNode
   * @param {String} url
   */
  setManuallySwitched: function(browserNode, url)
  {
    browserNode.setAttribute("manuallySwitched", Utils.getEffectiveHost(url) || "");
  },
  
  shouldLoadInBrowser: function(browser, locationSpec)
  {
    return PolicyPrivate.shouldLoadInBrowser(browser, locationSpec);
  },
  
  /**
   * Notifies "http-on-modify-request" handlers about whether a URL is loaded in a root window
   * @param {nsIDOMNode} browserNode
   * @param {String} locationSpec
   */
  notifyIsRootWindowRequest: function(browserNode, locationSpec)
  {
    Utils.LOG("notifyIsRootWindowRequest: " + locationSpec);
    browserNode.setAttribute("isRootWindow", locationSpec);
  },
  
  isRootWindowRequest: function(browserNode, locationSpec)
  {
    let rootWindowSpec = browserNode.getAttribute("isRootWindow");
    let result = Utils.fuzzyUrlCompare(rootWindowSpec, locationSpec);
    if (result)
    {
      browserNode.removeAttribute("isRootWindow");
      Utils.LOG("isRootWindowRequest: true for " + locationSpec);
    }
    else
    {
      Utils.LOG("isRootWindowRequest: false for " + locationSpec);
    }
    return result;
  },
};

/**
 * Private nsIContentPolicy and nsIChannelEventSink implementation
 * @class
 */
var PolicyPrivate = {
  classDescription: "Fire-IE content policy",
  classID: Components.ID("005C9F5D-B31B-4E22-9B3C-7FA31D1F333A"),
  contractID: "@fireie.org/fireie/policy;1",
  xpcom_categories: ["content-policy"],

  //
  // nsISupports interface implementation
  //
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIContentPolicy, Ci.nsIObserver, Ci.nsIFactory, Ci.nsISupportsWeakReference]),

  //
  // nsIContentPolicy interface implementation
  //
  shouldLoad: function(contentType, contentLocation, requestOrigin, node, mimeTypeGuess, extra)
  {
    if (!Prefs.autoswitch_enabled) return Ci.nsIContentPolicy.ACCEPT;

    // Ignore requests within a page
    if (contentType != Ci.nsIContentPolicy.TYPE_DOCUMENT) return Ci.nsIContentPolicy.ACCEPT;

    let location = Utils.unwrapURL(contentLocation);

    // Ignore whitelisted schemes
    if (!Policy.isSwitchableScheme(location)) return Ci.nsIContentPolicy.ACCEPT;

    let browserNode = null;
    try
    {
      browserNode = node ? node.QueryInterface(Ci.nsIDOMNode) : null;
    }
    catch (ex) {}
    if (!browserNode) return Ci.nsIContentPolicy.ACCEPT;
    
    return this.shouldLoadInBrowser(browserNode, location.spec);
  },
  
  shouldLoadInBrowser: function(browserNode, locationSpec)
  {
    // User has manually switched engine
    if (Policy.isManuallySwitched(browserNode, locationSpec))
      return Ci.nsIContentPolicy.ACCEPT;
    
    // Make sure the request comes from a tab
    let tab = Utils.getTabFromBrowser(browserNode);
    if (!tab)
      return Ci.nsIContentPolicy.ACCEPT;

    // Check engine switch list
    if (Policy.checkEngineRule(locationSpec))
    {
      Utils.runAsync(function()
      {
        browserNode.loadURI(Utils.toContainerUrl(locationSpec));
      }, this);
      return Ci.nsIContentPolicy.REJECT_OTHER;
    }
    // Check engine switch back list
    if (Utils.isIEEngine(locationSpec))
    {
      let url = Utils.fromContainerUrl(locationSpec);
      if (Policy.isManuallySwitched(browserNode, url))
        return Ci.nsIContentPolicy.ACCEPT;
      if (Policy.checkEngineExceptionalRule(url))
      {
        Utils.runAsync(function()
        {
          browserNode.loadURI(Utils.toSwitchJumperUrl(url));
          // Check dangling CIEHostWindow s, as we just skipped attaching them to a plugin Object
          UtilsPluginManager.checkDanglingNewWindow(tab);
        }, this);
        return Ci.nsIContentPolicy.REJECT_OTHER;
      }
    }
    
    return Ci.nsIContentPolicy.ACCEPT;
  },

  shouldProcess: function(contentType, contentLocation, requestOrigin, insecNode, mimeType, extra)
  {
    return Ci.nsIContentPolicy.ACCEPT;
  },

  //
  // nsIObserver interface implementation
  //
  observe: function(subject, topic, data, additional)
  {
    switch (topic)
    {
    case "http-on-modify-request":
      {
        if (!(subject instanceof Ci.nsIHttpChannel)) return;

        let url = subject.URI.spec;
        let domain = Utils.getHostname(url);
        
        // Changes the UserAgent to that of IE if necessary.
        let match;
        if (match = Policy.checkUserAgentRule(url, domain))
        {
          // Change user agent
          let specialUA = (match.specialUA && match.specialUA.toUpperCase() == "ESR")
            ? Utils.esrUserAgent : null;
          let userAgent = specialUA || Utils.ieUserAgent;
          if (userAgent)
            subject.setRequestHeader("user-agent", userAgent, false);
        }
        
        if (!Prefs.autoswitch_enabled)
          break;
        
        // isWindowURI
        if (!(subject.loadFlags & Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI))
          break;

        let browser = Utils.getRequestBrowser(subject);
        if (!browser)
          break;
        
        let wnd = Utils.getRequestWindow(subject);
        
        if (Policy.isRootWindowRequest(browser, url) ||
            (wnd && Utils.isRootWindow(wnd)))
        {
          // User has manually switched to Firefox engine
          if (Policy.isManuallySwitched(browser, url))
            break;

          // The browser must be in a tab
          let tab = Utils.getTabFromBrowser(browser);
          if (!tab || !tab.linkedBrowser)
            break;

          // Check engine switch list
          if (!Policy.checkEngineRule(url))
            break;

          subject.cancel(Cr.NS_BINDING_ABORTED);
          this._switchToIEEngine(url, tab, subject);
        }
        break;
      }
    } // switch (topic)
  },

  //
  // nsIFactory interface implementation
  //
  createInstance: function(outer, iid)
  {
    if (outer) throw Cr.NS_ERROR_NO_AGGREGATION;
    return this.QueryInterface(iid);
  },

  _switchToIEEngine: function(url, tab, httpChannel)
  {
    // http headers
    let headers = this._getAllRequestHeaders(httpChannel);

    // post data
    let post = "";
    let uploadChannel = httpChannel.QueryInterface(Ci.nsIUploadChannel);
    if (uploadChannel && uploadChannel.uploadStream)
    {
      let len = uploadChannel.uploadStream.available();
      if (len > 0)
        post = NetUtil.readInputStreamToString(uploadChannel.uploadStream, len);
    }

    // Pass the navigation paramters througth tab attributes
    let param = {
      headers: headers,
      post: post
    };
    Utils.setTabAttributeJSON(tab, "fireieNavigateParams", param);

    Utils.runAsync(function()
    {
      tab.linkedBrowser.loadURI(Utils.toContainerUrl(url));
    }, this);

  },

  _getAllRequestHeaders: function(httpChannel)
  {
    let visitor = function()
    {
      this.headers = "";
    };
    visitor.prototype.visitHeader = function(aHeader, aValue)
    {
      this.headers += aHeader + ":" + aValue + "\r\n";
    };
    let v = new visitor();
    httpChannel.visitRequestHeaders(v);
    return v.headers;
  }
};
