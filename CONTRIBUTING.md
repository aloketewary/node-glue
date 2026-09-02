# Contributing

## Requirements

- macOS or Linux
- Node.js `>=20.5.0`
- npm

## Development setup

```bash
npm ci
npm run check
npm run build
```

Run the CLI from the checkout with:

```bash
node dist/cli.js --help
```

Do not use `npm link` as part of normal development or user installation. Validate the package artifact with:

```bash
npm pack --dry-run
```

## Before submitting changes

- Run `npm run check`.
- Run `npm run build`.
- Confirm generated package output contains only intended files.
- Update `README.md` and `CHANGELOG.md` when user-visible behavior changes.
- Keep lifecycle scripts disabled by default unless explicitly required by the feature.
