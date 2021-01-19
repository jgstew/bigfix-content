
ClientUIs are html files that are displayed within the BigFix Client UI. 

ClientUIs can have client side relevance substitution to display dynamic content. 

ClientUIs can use javascript to enhance the function of the page, but the javascript cannot dynamically get relevance results like is possible in a Console Dashboard or Web Report. The only option to update the relevance results within a ClientUI Dashboard is to refresh the entire page.

ClientUIs can do a few special HTML link things, including `takeoffer:nnn` which will trigger an offer where `nnn` is the ID of the offer. See `(ids of it, values of headers "Subject" of it) of relevant offer actions of sites`

The ClientUI folder location is given by the relevance: `(it & "\__UISupport") of pathnames of data folders of client` and by default on most windows systems will be: `C:\Program Files (x86)\BigFix Enterprise\BES Client\__BESData\__UISupport`

### Technition Client Dashboard:

**From:** https://forum.bigfix.com/t/bes-7-0-techinician-view/10362/2

The short answer to your question is that you put a file `_technician.html` in the `__UISupport` folder of the agent's data folder (default location `C:\Program Files\BigFix Enterprise\BES Client\__BESData\__UISupport`) and then `CTRL-ALT-SHIFT-T` from the agent UI will trigger this dashboard (which is relevance and HTML). Or... you can use the file `_dashboard.html` and it will be a dashboard view visible to the end user (you can use both dashboards). You will need to restart the BES Client whenever you put these files in place or whenever you change these files.

### Related:

- https://forum.bigfix.com/t/enable-device-user-to-see-action-history-in-clientui/16972
- https://forum.bigfix.com/t/client-collected-data-report/17622/10
- https://forum.bigfix.com/t/client-ui-tab-options-order/19762
- https://forum.bigfix.com/t/what-is-report-minimumanalysisinterval-client-setting/13143/10
- https://forum.bigfix.com/t/how-do-you-enable-the-technician-mode-in-the-clientui/15673
