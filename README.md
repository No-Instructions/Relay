# Relay 🛰️

True **multiplayer mode** for Obsidian. 💃🕺

-   **Collaborate in real time** with live cursors.
-   **Edit offline** and sync seamlessly when you're back on.
-   **Share folders** and manage access to updates.

![Relay Product Demo](https://f.system3.md/cdn-cgi/image/format=auto/demo.gif)

Relay is a collaborative editing plugin for Obsidian by [System 3](https://system3.md/). It uses CRDTs to enable snappy, local-first, real-time and asynchronous collaboration.

[Join our Discord](https://discord.system3.md) for support and a good time.

### How does Relay work?

In a nutshell, Relay:

1. **Tracks updates to designated folders**. The plugin uses conflict-free replicated data types (CRDTs) to track updates to folders that you designate within your vault.
2. **Relays updates.** It sends those updates up to Relay servers 🛰️, which then echo the updates out to all collaborators on the relay.
3. **Integrates updates.** Your collaborator receives the updates and integrates them seamlessly as they come in.

### What's a CRDT?

Great question. CRDT stands for **conflict-free replicated data type** and it's a technology that's critical to making local-first real-time collaboration work.

> The fundamental idea is this: You have data. This data is stored on multiple replicas. CRDTs describe how to coordinate these replicas to always arrive at a consistent state. [1]

For a great intro and overview, watch the first 10 minutes of this video by Martin Kleppmann. If you want to get into the nitty-gritty, watch the whole thing.

[![Intro to the Modern State of Synchronization](https://f.system3.md/cdn-cgi/image/format=auto,width=600/crdt-explainer-thumnail.png)](https://youtube.com/watch?v=x7drE24geUw)

For more, check out this video: [Intro to the Modern State of Synchronization](https://youtu.be/tSvlvMTHhWY?si=Rp6FepkeS7N6y3zO) by [Kevin Jahns](https://github.com/dmonad). Jahns is the maintainer of [Yjs](https://docs.yjs.dev/), which is the the open source CRDT that we use in Relay.

## What can I do with Relay?

Oh, the things you can do.

Here's a video tour:  
[![Watch the video](https://f.system3.md/cdn-cgi/image/format=auto,width=600/walkthrough-video-thumbnail.png)](https://youtu.be/Ol6zDF5vrZo)


### Create a new relay

1. Go to Obsidian settings (gear icon in lower left of Obsidian)
2. Go to Relay settings (on the left, at the bottom)
3. Create new relay
4. Add shared folder(s) to the relay

![Demo - Create a new Relay](https://f.system3.md/cdn-cgi/image/format=auto/create%20a%20new%20relay.gif)

### Add users to the relay by giving them a share key

1. Go to settings for your relay
2. Grab the share key
3. Give it to your people

![Demo -Sharing a Relay](https://f.system3.md/cdn-cgi/image/format=auto/sharing%20a%20relay.gif)

### Collaborate to your heart's content

-   If you're in a note at the same time, you'll see each others' cursors
-   You can edit the same block at the same time (magic of CRDTs)
-   You can edit offline and it'll all be fine when you come back on (CRDTs ftw)
-   If you hit any bugs or have questions/requests let us know in the [Discord](https://discord.system3.md)

### Kick user from a relay

-   Right now anyone with the share key can join the relay
-   So you can kick the user but they could rejoin if they want
-   We'll be adding stricter sharing options in the future

![Demo - Kick a user from a Relay](https://f.system3.md/cdn-cgi/image/format=auto/kick%20user%20from%20a%20relay.webp)

### Join someone else's relay

1. Get their share key
2. Use it to join their relay
3. Add the folders you want to your vault

![Demo - Join a Relay](https://f.system3.md/cdn-cgi/image/format=auto/join%20a%20relay.webp)

### Destroy the relay when you're done

If you're the owner of a relay, you can destroy the copy on the server.

If you're a member but not the owner, you can leave the relay (destroy your connection to the server), and you can destroy the local data.

## FAQ

Asked more or less frequently.

### Which file types are supported?

Relay currently syncs:

-   folders
-   markdown files

Other file types are coming soon!

### How much does Relay cost?

#### Free

-   25 Relays
    -   3 users per Relay
-   10MiB Markdown edit history storage

#### Team $10/mo

-   Unlimited Relays
    -   10 users per Relay
        -   $2 per additional user up to 20 users.
-   Unlimited markdown edit history storage
-   ?? GB of Attachment Storage

#### Pro (???)

-   Custom per-user pricing
-   BYO-storage


### Do I need to be online to use Relay?

Relay is local-first -- this means that all of your edits are tracked locally and the server is used to _relay_ the edits to your collaborators. You can work offline and your edits will be merged once you come back online.

### How are edits merged?

We use a **Conflict-Free Replicable Data Types** (CRDTs) provided by the excellent yjs library.

### Can I self-host?

The obsidian plugin code is MIT licensed, but the code that powers our service is proprietary.

We probably won't release the server code, but here are some things we're thinking about to make that less painful:

#### Peer to Peer

We'd like to eventually make Relay servers additive rather than required (support peer-to-peer connections).

#### Localized Pricing

We hope to implement localized pricing so that the pricing is fair wherever you are. While we want to be able to fund working on this full time, we also want everyone to be able to use Relay. If the pricing is way off, or you can't afford it then please email us.

#### Data Sovereignty

We want to support both end-to-end encryption and bring-your-own s3-compatible storage. Let us know if either of these are a priority for you.

## Latency

We're working on making our service work globally with low millisecond latency. Let us know if your experience was bad.

[matt@noinstructions.ai](mailto:matt@noinstructions.ai) [daniel@noinstructions.ai](mailto:daniel@noinstructions.ai) [Talk to us on Discord](https://discord.system3.md)

### Who's behind Relay?

Relay is made by [System 3](https://system3.md/). The legal entity behind System 3 is [No Instructions, LLC](http://noinstructions.ai/).

Right now the whole operation is two people:

-   Dan, a software engineer who has worked at places like [Planet](http://planet.com/) and [Benchling](https://www.benchling.com/)
-   Matt, a product manager and psychotherapist (in training) who has worked at places like [Meta AI](https://ai.meta.com/meta-ai/), [Lumosity](https://www.lumosity.com/en/), and [Big Health](https://www.bighealth.com/)

## Do you have a privacy policy?

Yes: [https://system3.md/Privacy+policy](https://system3.md/Privacy+policy).


## Installing Relay

You can search for `Relay` in the Obsidian Community plugins list,
or click this [Obsidian Plugin Link](https://obsidian.md/plugins?search=system3-relay).


## Installing the latest Beta Release

BRAT is the **Beta Reviewer's Auto-update Tool for Obsidian**.

### 1. Install BRAT

First we need to install the Obsidian Plugin [BRAT](https://github.com/TfTHacker/obsidian42-brat). If you haven't yet enabled community plugins, you can follow [this guide](https://help.obsidian.md/Extending+Obsidian/Community+plugins) on help.obsidian.md.

Search for "BRAT" and install the plugin by TfTHacker.

### 2. Add Relay via BRAT

-   Once you have BRAT installed open the Settings pane by pressing on the great in the bottom left of Obsidian.
    -   In Settings, navigate to BRAT under "community plugins" at the bottom of the right-hand section.
    -   In the BRAT configuration page click "Add Beta plugin".
        -   Enter in `No-Instructions/Relay`.
        -   Ensure that `Enable after installing the plugin` is checked.
        -   Click `Add Plugin`

[Join our Discord](https://discord.system3.md)!

---

[1] Intro to CRDTs by Lars Hupel [https://lars.hupel.info/topics/crdt/01-intro/](https://lars.hupel.info/topics/crdt/01-intro/)
