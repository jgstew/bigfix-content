a place for session relevance queries

###

- `( html tags ("span", (it as html) of firsts 1 of it) ) of "False"` = `<span>F</span>`
- MAC Addresses: `( concatenations ", " of (it as trimmed string) of (preceding text of first " (" of it | it) of (following text of first ": " of it | it) of values of results from (bes properties whose(name of it starts with "MAC Addresses - ")) of it ) of bes computers`
