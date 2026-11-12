# Locks of the image

[overview.md](../architecture/overview.md) gives the image, and `pnpm test:image` restarts it after a hard kill.

## Checks

- On Linux, `ps` computes `lstart` from the boot time in `/proc/stat`. An NTP step or a suspend can move that time by
  1 s, and `FileLocks` then sees a live holder as stale. Check this on a real VPS. If it occurs, allow 1 s, as the
  groups file does ([sandbox.md](../architecture/sandbox.md)). On an Ubuntu VM with NTP active,
  `lstart` stayed the same over 10 minutes, with no NTP step or suspend.
