#!/bin/sh
set -e

# The router runs as the unprivileged 'node' user. When started as root (the default), hand it the
# data and cache folders first: docker creates missing bind-mount sources as root, which 'node' can't write.
if [ "$(id -u)" = "0" ]; then
    for dir in "${CONFIG_ROOT:-config}" "${CACHE_ROOT:-cache}"; do
        mkdir -p "$dir"
        if [ ! -w "$dir" ]; then
            echo "note: $dir is read-only, leaving its ownership alone" >&2
        # Only walk the tree when ownership is wrong, so restarts stay quick
        elif [ "$(stat -c %u "$dir")" != "$(id -u node)" ]; then
            chown -R node:node "$dir" 2>/dev/null || echo "warning: could not take ownership of $dir" >&2
        fi
    done

    exec setpriv --reuid=node --regid=node --init-groups node service.js
fi

# Already started as a specific user (e.g. compose 'user:'), so just run
exec node service.js
