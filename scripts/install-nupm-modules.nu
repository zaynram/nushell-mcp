#!/usr/bin/env -S nu --stdin
let url: string = 'https://raw.githubusercontent.com/zaynram/nupm-registry/refs/heads/main/scripts/install.nu'
let tmp: path = mktemp --suffix=.nu --dry
http get $url | save $tmp
try { chmod +x $tmp } catch { error make 'unable to make script executable' }
let output: record = ^$tmp --default --name=ramda out+err>|
  | complete
if $output.exit_code == 0 or $output.stdout =~ `Registry 'ramda' already exists` { return }
error make --unspanned $"registry installation failed\n($output.stdout)"
