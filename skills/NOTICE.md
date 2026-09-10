# Bundled skills

`skills/paperclip/` is a verbatim copy of the `paperclip` operational skill from
the upstream Paperclip repository (https://github.com/paperclipai/paperclip,
MIT license). It is bundled so a DeepSeek agent can load the full control-plane
reference through the `load_skill` tool even when the Paperclip server does not
deliver runtime skill entries for the agent.

Refresh it with:

```sh
rm -rf skills/paperclip && cp -r <paperclip checkout>/skills/paperclip skills/paperclip
```
