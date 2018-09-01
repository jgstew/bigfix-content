a place for session relevance queries

###

- `( html tags ("span", (it as html) of firsts 1 of it) ) of "False"` = `<span>F</span>`
- MAC Addresses: `( concatenations ", " of unique values of (it as uppercase) of (it as trimmed string) of (preceding text of first " (" of it | it) of (following text of first ": " of it | it) of values of results from (bes properties whose(name of it starts with "MAC Addresses - ")) of it ) of bes computers`
- `tables of html concatenations of (trs of html concatenations of tds of (links of it; (html it) of name of site of it)) of fixlets whose(analysis flag of it AND active flag of best activation of it AND name of it starts with "Network Information (") of bes sites whose("BES Inventory and License" = name of it)`
- `tables of html concatenations of (trs of html concatenations of tds of ( (html it) of status of best activation of it; links of it; (html it) of name of site of it; (html it) of ("Subscribed: " & it) of subscription mode of site of it) ) of fixlets whose(analysis flag of it AND active flag of best activation of it AND name of it starts with "Network Information (") of bes sites whose("BES Inventory and License" = name of it)`
- `tables of ( ( thead of trs of html concatenations of ths of ("Activation";"Analysis";"Site";"Subscribed") ) & it) of tbodys of html concatenations whose(it as string != "") of (trs of html concatenations of tds of ( (html it) of status of best activation of it; links of it; (html it) of name of site of it; (html it) of subscription mode of site of it) ) of fixlets whose(analysis flag of it AND active flag of best activation of it AND name of it starts with "Network Information (") of bes sites whose("BES Inventory and License" = name of it)`
