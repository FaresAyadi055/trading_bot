To install dependencies:
```sh
bun install
```

To run:
```sh
bun run dev
```

open http://localhost:3000

# light weight binance spot trading bot (live simulation)

## objective: 
we want to build a live binance simulation for a trading since we are operating at a 4 hour frequency we will only use rest api no websocket while for state management, persistance and transaction logs we will use the bun: sqlite.
the bot is a json based decision tree where the hono application is charged with compute and store it's input feature and use a typescript parser to do buy / sell actions.
the app should have a bun worker that routinely fetches the needed data from binance rest api and the bot supports the following assets (BTC, ETH, BNB, SOL) and the capital is always in USDT.
## features:
- the sqlite state management should help the bot recover from a power or connection interrupts
- single or multi asset support where a bot instance can either receive a single market single or multiple signals but with a one trade at a time rule where if the bot buys one asset he will only receive signal from that asset until it exits the trade.
- bot instanciation where we can create a bot that can either trade in a single or multiple assets and it should have it's own seperate transaction logs and potfolio 
- telegram bot action notifications that notify the bot ID, it's action and the profit / loss if it is a sell action
- simple html dashboard with access token, it shows profile info and analytics of each instance if needed call the binance api directly from the frontend avoid serving it from the hono server. should also have control settings like activate or reactivate bot that either do the action immediatly or wait for it to exit a trade if it is in one, we should also be able to edit the trading assets of a bot or delete it alltogether but make sure there is a wait for trade exit logic, we also should be able to create new instances from there and update the USDT capital and download bot data as json.

## optimizations
-  client side rendering
- don't hold on to old candle data and metrics once new data come overwrite to keep storage size constant exept for data that must scale like bot instances and transaction logs
- deleting a bot also delete it's footprint from the database
- keep hono idle memory usage minimal
## documentation
- track the remaining tasks in AGENTS.md
- the lock the final database schema in schema.sql
- document api points in openapi.yml
## what is already there
- boilerplate bun hono project
- doc files
- json decision tree with a zod schema and documentation in bot folder