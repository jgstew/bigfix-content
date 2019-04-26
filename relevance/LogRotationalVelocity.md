
### "Rotational Velocity" of Log Files

Measure the average time between Log File rotations using BigFix relevance.

Here is an example for the BigFix root server `server_audit` logs:

`( (now - item 1 of it) / item 0 of it) of (number of elements of it, minima of modification times of (files it) of elements of it) of sets of pathnames of files whose(name of it starts with "server_audit." AND name of it ends with ".log") of folders "C:\Program Files (x86)\BigFix Enterprise\BES Server"`

Here is another example for the BESRelay logs (on Root servers and Relays, for all OSes):

`( (now - item 1 of it) / item 0 of it) of (number of elements of it, minima of modification times of (files it) of elements of it) of sets of pathnames of files whose(name of it starts with "BESRelay." AND name of it contains ".log") of ( folders "/var/log" ; (folders "BES Server" of it; folders "BES Relay" of it) of folders "C:\Program Files (x86)\BigFix Enterprise" )`
