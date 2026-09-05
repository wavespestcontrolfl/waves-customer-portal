# Self-hosted portal fonts

These are the Google Fonts families previously requested by the portal and
preview HTML documents. The application and standalone preview entries share
`client/src/fonts.css`; Inter and Roboto continue to use existing Fontsource
packages. No new npm dependency is needed.

`fonts.css` preserves the upstream styles, weight ranges, optical-size axes and
Unicode subsets. Browsers download only the subsets and faces they use. The
49 WOFF2 files total about 1.3 MiB across all ten families and all supplied subsets.

`sources.json` records the immutable upstream font URLs and SHA-256 digests.
License snapshots are included for each family (SIL OFL, except Luckiest Guy's
Apache 2.0 license). Files are unmodified; the CSS changes only font URLs to local
paths. Font filenames are content hashes, so replacing bytes requires a new name.

To update, retrieve CSS for the same family/style/weight/optical-size ranges from
Google Fonts with a modern browser user agent, save every referenced WOFF2 and
its license, and update CSS, hashes and source URLs together. Run
`npm run test:qa-workflow`, `npm run qa:previews`, the estimate preview audit,
and `npm run build`. Inspect desktop and mobile captures before review.
