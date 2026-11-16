# DarkNode

A responsive recreation of the DarkNode investment dashboard reference, built with React, TypeScript, Vite, React Router, Tailwind CSS, Lucide icons, and Framer Motion.

## Routes

- `/` - Home stock list and search
- `/arena` - Investor rank and active auctions
- `/investments` - Portfolio summary and holdings
- `/account` - Account actions, preferences, and help

## Development

```sh
npm install
npm run dev
```

`npm run build` runs the TypeScript project build and creates the production bundle in `dist/`.

## Supabase

The app uses Supabase Auth and Postgres for account profiles, wallet balances, investments, auctions, referrals, and loan requests. See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for setup and migration instructions.

Portfolio, auction, and investment activity are simulations. The app does not provide deposit or withdrawal features.
