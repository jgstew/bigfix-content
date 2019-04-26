
### "Rotational Velocity" of Log Files

Measure the average time between Log File rotations using BigFix relevance.

Here is an example for the BigFix root server `server_audit` logs:

`( (now - item 1 of it) / item 0 of it) of (number of elements of it, minima of modification times of (files it) of elements of it) of sets of pathnames of files whose(name of it starts with "server_audit." AND name of it ends with ".log") of folders "C:\Program Files (x86)\BigFix Enterprise\BES Server"`
