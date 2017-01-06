## Dashboards / Wizards meant to be used in the BigFix console.

What is a Dashboard?

What is a Wizard?

How are they different than a Custom Web Report?

- They are all basically the exact same thing. The main difference is that a Wizard is expected to have multiple "Pages" and "Steps" that are separate HTML documents internally. Dashboards and Custom Web Reports are expected to be a single HTML document, but through use of JavaScript, that single HTML document could have a wizard within it, or some other method for emulating multiple "Steps", though it could also be anything else.

### Two options for using these:

- Put the dashboard files in a folder, then load dynamically using the Console's `Load Wizard` option in the Debug Menu.
 - Placing the files in a folder before loading with the console is important, because the console will copy the entire contents of the folder.
- Add the dashboard files to a custom site. 

### Load javascript libraries from CDN with fallback:

    <script src="//ajax.googleapis.com/ajax/libs/jquery/1.5.1/jquery.min.js"></script>
    <script>window.jQuery || document.write('<script src="js/libs/jquery-1.5.1.min.js">\x3C/script>')</script>

### References:

- http://stackoverflow.com/a/9400432/861745
- http://stackoverflow.com/questions/5257923/how-to-load-local-script-files-as-fallback-in-cases-where-cdn-are-blocked-unavai
- http://fallback.io/
 - https://github.com/dolox/fallback/issues/77
- https://github.com/bigfix/adf
- https://bitbucket.org/bigfixme/dashboard-framework

### Examples:

- https://bigfix.me/cdb/dashboard/115
