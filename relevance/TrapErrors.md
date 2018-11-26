
This is a method that can be used to try to force a boolean result on error: (returns FALSE on most Errors)

    exists TRUE whose ( If TRUE Then /* force boolean result */ This Is Invalid Else FALSE )
  
Examples:

- https://forum.bigfix.com/t/deal-with-non-existing-plural-values-in-relevance-language/19297/3
- https://github.com/jgstew/remote-relevance/blob/master/Remote_Relevance_Action_TEMPLATE.bes.xml#L9

This works both in Client Relevance & Session Relevance


Related:

- https://www.ibm.com/developerworks/community/blogs/e9d21113-aa93-467e-ac77-a0d20a21eaec/entry/BigFix_Relevance_Guard_or_Guarded_Relevance?lang=es
