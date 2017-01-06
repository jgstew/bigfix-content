## Dashboards / Wizards meant to be used in the BigFix console.

### Two options for using these:

- Put the dashboard files in a folder, then load dynamically using the Console's `Load Wizard` option in the Debug Menu.
 - Placing the files in a folder before loading with the console is important, because the console will copy the entire contents of the folder.
- Add the dashboard files to a custom site. 

### Load javascript libraries from CDN with fallback:

    <script src="//ajax.googleapis.com/ajax/libs/jquery/1.7.2/jquery.min.js"></script>
    <script>window.jQuery || document.write('<script src="path/to/your/jquery"><\/script>')</script>

### References:

- http://stackoverflow.com/a/9400432/861745

