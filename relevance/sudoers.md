These are not tested, but based on other relevance.

Root user sessions:
- `locked lines containing "session opened for user root" of files ("auth.log";"secure") of folders "/var/log"`
- `number of locked lines containing "session opened for user root" of files ("auth.log";"secure") of folders "/var/log"`

failed sudo attempts:

- `locked lines containing ("pam_unix(sudo:auth): authentication failure;";"incorrect password attempts") of files ("auth.log";"secure") of folders "/var/log"`

failed esecalation attempts:

- `locked lines containing "user NOT in sudoers" of files ("auth.log";"secure") of folders "/var/log"`

failed su attempts:

- `locked lines containing ("pam_unix(su-l:auth): authentication failure;";"FAILED su for") of files ("auth.log";"secure") of folders "/var/log"`

dnf:

- `modification times of files ("apt/history.log";"dnf.log") of folders "/var/log"`

## Related:

- https://github.com/jgstew/bigfix-content/blob/main/analyses/Sudoers%20-%20Linux%20Unix%20MacOS.bes
- https://github.com/jgstew/bigfix-content/blob/main/analyses/Linux%20package%20info%20-%20RPM%26DEB.bes
