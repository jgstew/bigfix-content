
### "Rotational Velocity" of Log Files

Measure the average time between Log File rotations using BigFix relevance.

Here is an example for the BigFix root server `server_audit` logs: (written for Windows, but can be adapted to RHEL)

`( (now - item 1 of it) / item 0 of it) of (number of elements of it, minima of modification times of (files it) of elements of it) of sets of pathnames of files whose(name of it starts with "server_audit." AND name of it ends with ".log") of folders "C:\Program Files (x86)\BigFix Enterprise\BES Server"`

Here is another example for the BESRelay logs (on Root servers and Relays, for all OSes):

`( (now - item 1 of it) / item 0 of it) of (number of elements of it, minima of modification times of (files it) of elements of it) of sets of pathnames of files whose(name of it starts with "BESRelay." AND name of it contains ".log") of ( folders "/var/log" ; (folders "BES Server" of it; folders "BES Relay" of it) of folders "C:\Program Files (x86)\BigFix Enterprise" )`

Example for BESTools logs:

`( (now - item 1 of it) / item 0 of it) of (number of elements of it, minima of modification times of (files it) of elements of it) of sets of pathnames of files whose(name of it starts with "BESTools." AND name of it contains ".log") of ( folders "/var/log" ; (folders "BES Server" of it; folders "BES Relay" of it) of folders "C:\Program Files (x86)\BigFix Enterprise" )`

Approximate bytes written per day:

`( item 0 of it / ((now - item 1 of it) / day) ) of (sums of sizes of (files it) of elements of it, minima of modification times of (files it) of elements of it) of sets of pathnames of files whose(name of it starts with "server_audit." AND name of it contains ".log") of ( folders "/var/log" ; (folders "BES Server" of it; folders "BES Relay" of it) of folders "C:\Program Files (x86)\BigFix Enterprise" )`


### References:

- https://www.ibm.com/developerworks/community/wikis/home?lang=en#!/wiki/Tivoli+Endpoint+Manager/page/Common+File+Locations
- https://www.ibm.com/support/knowledgecenter/en/SSQL82_9.5.0/com.ibm.bigfix.doc/Platform/Installation/c_logfiles.html
