# Optional Sources built in, not a plugin system

Docker and the disk are always on; Gatus, Jellyfin and a Report are built into the code but stay off until their
config is set, and their Tools aren't offered while off. We chose this middle ground over two alternatives. Hard-coding
one Host's setup would make the public repo useless to anyone else. A plugin system (load any Source from outside the
package) is where small general-purpose tools balloon: a plugin interface to design, version and document before the
first real feature works. Built-in optional Sources serve anyone running the same common tools, and anyone else still
gets the Docker and disk core.

## Consequences

Adding a Source means a code change and a release, not a config file. That's acceptable while Sources are few and
common; if people ask for many different ones, a plugin interface can be designed then, from real examples.
