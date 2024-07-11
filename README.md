# Relay 🛰️

[Relay](https://system3.studio/relay) is a collaborative editing plugin for [Obsidian](https://obsidian.md) built by [No Instructions, LLC](https://noinstructions.ai).
The Relay Obsidian plugin connects to hosted Relay servers to forward document updates between users.

# FAQ

## Which file types are supported?
Relay currently syncs:
- folders
- markdown files

Other file types are coming soon!

## How much does Relay cost?
We haven't implemented billing yet, but here's our intended pricing model:

#### Free
- 25 Relays
	- 3 users per Relay
- 10MiB Markdown edit history storage

#### Team $10/mo
- Unlimited Relays
	- 10 users per Relay
		- $2 per additional user
- Unlimited markdown edit history storage
- ?? GB of Attachment Storage

#### Pro (???)
* Custom per-user pricing
* BYO-storage

## How do I increase the user limit on my Relay?
Since we don't have billing yet, if you want to bump the user limit on your relay you can email me at daniel@noinstructions.ai .

## Do I need to be online to use Relay?
Relay is local-first -- this means that all of your edits are tracked locally and the server is used to *relay* the edits to your collaborators. You can work offline and your edits will be merged once you come back online.

## How are edits merged?
We use a **Conflict-Free Replicable Data Types** (CRDTs) provided by the excellent yjs library.

## Can I self-host?
The obsidian plugin code is MIT licensed, but the code that powers our service is proprietary.

We probably won't release the server code, but here are some things we're thinking about to make that less painful:
#### Peer to Peer
We'd like to eventually make Relay servers additive rather than required (support peer-to-peer connections).

#### Localized Pricing
We hope to implement localized pricing so that the pricing is fair wherever you are.
While we want to be able to fund working on this full time, we also want everyone to be able to use Relay.
If the pricing is way off, or you can't afford it then please email us.

#### Data Sovereignty
We want to support both end-to-end encryption and bring-your-own s3-compatible storage. Let us know if either of these are a priority for you.

#### Latency
We're working on making our service work globally with low millisecond latency. Let us know if your experience was bad.


matt@noinstructions.ai
daniel@noinstructions.ai


# Installing the latest Beta Release
> Relay is currently in limited beta, and is not yet in the Obsidian plugin repository.
> If you don't have Relay installed, you can beta test Relay using BRAT.

BRAT is the **Beta Reviewer's Auto-update Tool for Obsidian**.

## Install BRAT
First we need to install the Obsidian Plugin [BRAT](https://github.com/TfTHacker/obsidian42-brat).
If you haven't yet enabled community plugins, you can follow [this guide](https://help.obsidian.md/Extending+Obsidian/Community+plugins) on help.obsidian.md.

Search for "BRAT" and install the plugin by TfTHacker.

## Adding Relay to BRAT
- Once you have BRAT installed open the Settings pane by pressing on the great in the bottom left of Obsidian.
  - In Settings, navigate to BRAT under "community plugins" at the bottom of the right-hand section.
  - In the BRAT configuration page click "Add Beta plugin".
    - Enter in `No-Instructions/Relay`.
    - Ensure that `Enable after installing the plugin` is checked.
    - Click `Add Plugin`
