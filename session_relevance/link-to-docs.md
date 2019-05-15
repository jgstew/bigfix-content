

## Types:

### Type with Link:

- `( it, ("https://developer.bigfix.com/relevance/reference/" & it & ".html") of (concatenations "-" of substrings separated by " " of it) ) of (it as string as trimmed string) whose("" != it) of types`

### Property & Type

- `(concatenations "-" of it whose(it as trimmed string != "") of substrings separated by "," of substrings separated by "(" of substrings separated by ")" of substrings separated by ":" of substrings separated by ">" of substrings separated by "<" of substrings separated by " " of it) of (it as string as trimmed string) whose("" != it) of properties`
