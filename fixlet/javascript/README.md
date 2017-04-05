This is a folder to contain fixlets/tasks that are used to make javascript libraries available to other fixlets, tasks, dashboards, webreports, etc...

I'm changing up this a bit to a newer convention because I may use it for CSS or other types in some cases. Any format used must be able to be placed on a single line (tolerant of end of line removal)

## Mandatory fields

- Must be a Task: (Not a Fixlet)  `<BES><Task></Task></BES>`
 - This is to optimize the session relevance because there are generally very few tasks compared to fixlets.
- Title (Name): Must contain `Shared Library`
 - Title should follow convension: `Shared Library - Javascript - _JS_LIBRARY_NAME_.js - _JS_LIBRARY_VERSION_`
- MIMEField `version` must contain `_JS_LIBRARY_VERSION_`
- MIMEField `name` is `_JS_LIBRARY_NAME_.js`

## Related:

- https://bigfix.me/relevance/details/3019267
- https://bigfix.me/relevance/details/3019243
- https://bigfix.me/relevance/details/3019264 - Filenames of Wizards and Dashboards
- https://bigfix.me/relevance/details/3019266 - Dashboard and Wizard External Javascript Libraries
- https://bigfix.me/relevance/details/3019262 - Relevance that creates Session Relevance for JavaScript library loading
- https://bigfix.me/relevance/details/3019330 - Session Relevance that creates Session Relevance for JavaScript library loading
