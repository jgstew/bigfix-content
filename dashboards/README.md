## This folder contains Dashboards / Wizards for the BigFix Console.

**What is a Dashboard?**

**What is a Wizard?**

**How are they different than a Custom Web Report?**

- They are all basically the exact same thing.
- Any Custom Web Report could be a Dashboard or Wizard
- Any Dashboard or Wizard that primarily uses reports could be a Custom Web Report.
- The main difference is that a Wizard is expected to have multiple "Pages" and "Steps" that are separate HTML documents internally. Dashboards and Custom Web Reports are expected to be a single HTML document, but through use of JavaScript, that single HTML document could have a wizard within it, or some other method for emulating multiple "Steps", though it could also be anything else.
- a Custom Web Report is within a WebReports context, while Dashboards & Wizards are within a slightly different BigFix Console context. This means there are a few things that work in one and not the other. Generally Dashboards & Wizards are more capable than Custom Web Reports.

**How are all of the above different than a Client UI Dashboard?**

- The most significant difference about a Client UI Dashboard vs the others is that the Client UI Dashboard can only work with the single computer that it is running on, and cannot use Session Relevance. While the others (Dashboard/Wizard/WebReport) can provide summary results from multiple computers, they don't have to, which means if you have one that displays data from a single computer, then it is nearly identical to a Client UI Dashboard. The real power of Dashboards/Wizards/WebReports is that they can work with results across multiple computers, so using them for a single computer is a very simplified use case, but that doesn't change the fact that you could have a single unified view of a single computer across all of them, including a Client UI Dashboard.
- In order for this to really be the same, the Dashboard or WebReport would have to provide a way to pick a single computer to view the data, while the Client UI Dashboard would only work with the computer it is on.
- The other part that is needed is that the Client UI Dashboard would be powered by **client relevance** while the Dashboard or WebReport would have to rely on **Session Relevance** from **Properties** that use the same underlying **client relevance** behind the scenes.
- The computer summary view within the BigFix Console is effectively an example of a single computer view "Dashboard" or "WebReport" that could just as easily also be a **Client UI Dashboard**. Similar can be said of the similar views within **Bricks** or the **Computer Browser**.

**What about the BigFix Console? How is it similar to the above?**

- The Windows BigFix Console is a mix of native views and HTML views wrapped up in a complicated application.
- It can almost be thought of as a Dashboard of Dashboards.

## Options for using Dashboards:

- Put the dashboard files in a folder, then load dynamically using the Console's `Load Wizard` option in the Debug Menu.
  - Placing the files in a folder before loading with the console is important, because the console will copy the entire contents of the folder.
- Add the dashboard files to a custom site. 

### Get fully rendered HTML for debugging:

- http://stackoverflow.com/questions/10144820/get-the-html-of-the-javascript-rendered-page-after-interacting-with-it

### Important files for Dashboards:

- `C:\Program Files (x86)\BigFix Enterprise\BES Console\Reference\wizards.js`
- `C:\Program Files (x86)\BigFix Enterprise\BES Console\reference\common.js`
- `C:\Program Files (x86)\BigFix Enterprise\BES Console\Reference\BESOJO.xsd`

### Load javascript libraries from CDN with fallback:

    <script src="//ajax.googleapis.com/ajax/libs/jquery/1.5.1/jquery.min.js"></script>
    <script>window.jQuery || document.write('<script src="js/libs/jquery-1.5.1.min.js">\x3C/script>')</script>
    
- https://forum.bigfix.com/t/example-custom-web-report-with-pie-chart/16017/15
 - Load javascript embedded withing a BigFix Task with fallback to CDN

An even better option: https://github.com/jgstew/bigfix-content/tree/master/fixlet/javascript

### Dashboard Ideas:

- Delete help duplicate computers
- Remote Command-Line
  - select computer to target
  - take input of arbitrary commands
  - output results to file
  - attempt to send back results using cURL / WebSocket
  - read back results using BFQuery and/or Analysis
  - Very Similar idea as https://github.com/jgstew/remote-relevance
- Dashboard to help write session relevance for computer reporting: https://bigfix.me/relevance/details/3020326
- Deploy any fixlet or task or baseline with gradual roll out relevance added automatically
- MO Console Operator Management
 - help disable users that have not logged in over X days
 - delete console users that have been disabled for X days
 - help manage roles
 - help provision users
 - help with computer assignments
- [Client Settings Manager](https://github.com/jgstew/bigfix-content/blob/master/dashboards/ClientSettingsManager.ojo)
 - Help set client settings with drop downs
 - Help delete/unset client settings
 - What client settings exist only on a very small number of endpoints, which could be misconfigurations
  - https://bigfix.me/relevance/details/3019347
  - https://bigfix.me/relevance/details/3019348
 - Detect conflicting policy actions that set client settings (reapplication count? actionscript parsing?)
 - Detect overuse of clientsettings (too many unique setting names or name/value pairs)
  - client settings are gathered every report, which can be a problem
- Improved Fixlet Maker Dashboard - something to make content from templates
- Dashboard to help make parameterized fixlets
- "Computer Controller" - pick a particular computer from a table, then control it specifically
  - get state from analyses and BFQuery
  - check state changes using BFQuery and/or `notify client forcerefresh`
  - provide feedback on time of last update of displayed data, calculate age in JS, allow refresh with BFQuery if older than X time.
  - some basic computer info
  - some info on: current user / apparent primary user / assigned user
  - shutdown
  - restart
  - mute/unmute/volume
  - screen brightness
  - [screenshot](https://github.com/jgstew/bigfix-content/blob/master/dashboards/Screenshots.ojo)
  - RDP/VNC?
  - log collection & troubleshooting
- Recently Modified Custom Content
  - https://developer.bigfix.com/relevance/reference/bes-fixlet.html#source-release-date-of-bes-fixlet-date
  - https://developer.bigfix.com/relevance/reference/time.html#date-time-zone-of-time-date
  - Custom Content Modified in the past ? days by [All Users|Current User].
  - ? days = [1, 2, 5, 7, 15, 31, 90, 365, Max] where (it <= Max)
  - https://bigfix.me/relevance/details/3020171
  - Table:  Type, Name(Link), ModTime, Site?, User?


### References:

- https://www.ibm.com/developerworks/community/wikis/home?lang=en#!/wiki/Tivoli%20Endpoint%20Manager/page/IEM%20Console%20JavaScript%20_%20Relevance
 - The javascript available in fixlets seems similar to that in wizards. Might be the same.
- http://stackoverflow.com/a/9400432/861745
- http://stackoverflow.com/questions/5257923/how-to-load-local-script-files-as-fallback-in-cases-where-cdn-are-blocked-unavai
- http://fallback.io/
 - https://github.com/dolox/fallback/issues/77
- https://github.com/bigfix/adf
- https://bitbucket.org/bigfixme/dashboard-framework
- https://msdn.microsoft.com/en-us/library/jj676915(v=vs.85).aspx
- https://technet.microsoft.com/itpro/internet-explorer/ie11-deploy-guide/deprecated-document-modes
- https://github.com/Gavin-Paolucci-Kleinow/ie-truth
 - http://stackoverflow.com/questions/27912296/ie11-detect-whether-compatibility-view-is-on-via-javascript
- https://forum.bigfix.com/t/issues-with-console-dashboards-and-internet-explorer-versions-wizards-js-ie11-incompatibility/19790
- http://stackoverflow.com/questions/10144820/get-the-html-of-the-javascript-rendered-page-after-interacting-with-it

### Examples:

- https://bigfix.me/cdb/dashboard/115


### Related

- https://forum.bigfix.com/t/what-is-the-best-way-to-detect-if-running-in-a-dashboard-or-web-report/19924
- https://forum.bigfix.com/t/bigfix-global-search-dashboard-and-webreport/19963
- https://forum.bigfix.com/t/example-custom-web-report-with-pie-chart/16017
- https://forum.bigfix.com/t/how-to-create-a-custom-dashboard/15418/4
- https://forum.bigfix.com/t/report-available-asset-dashboard/6286
- https://forum.bigfix.com/t/webreport-results-via-soap-api/20131/3
- https://forum.bigfix.com/t/webreport-and-dashboard-that-recommends-relay-cache-sizing/19023
