# 🐟 Fishbowl

A local multiplayer party word game. One screen (TV or laptop) is the host; everyone else plays on their phone.

## Running it

```bash
npm install
npm start
```

Then:

1. On the computer connected to the TV, open **http://localhost:3000/?host**.
2. Everyone scans the QR code on screen with their phone. Phones must be on the **same Wi-Fi** as the computer.
3. Once at least 4 people have joined, the host presses **start**. Everyone adds their words on their phone, teams are picked, and you play.

If the QR code shows the wrong address (VPNs and virtual network adapters can cause this), set it yourself:
`PUBLIC_URL=http://192.168.1.20:3000 npm start`. The port can be changed with `PORT=4000`.

## How to play

Every player secretly adds a few words or phrases to the bowl. The players are split into two teams, and the teams take turns. On your turn, your phone shows a word. Get your teammates to guess as many as you can before the timer runs out. There are three rounds, and the same words are used in each one:

| Round | Rule |
| --- | --- |
| 1. Describe It | Say anything except the word itself |
| 2. Act It Out | Charades: no talking |
| 3. One Word | Exactly one word as a clue |

The team with the most points after round 3 wins.

## Don't feel like thinking of words?

In the lobby the host picks where the words come from and a **theme**:

- **Players write**: everyone types their own, and each box on the phone has a 🎲 button that suggests a word from the theme. **Suggest words for me** fills the empty boxes in one tap.
- **Generated**: the game fills the bowl itself, so nobody types anything.

Every generated word comes with a quick definition. The player giving clues sees it under the word on their phone.

Themes: Random mix (family-friendly), Movies & TV, Food & Drink, Animals & Nature, Places & Travel, Sports & Games, Music & Pop Culture, Everyday Life, History & Science, and the 18+ packs: **🐟 Fish Against Humanity** (silly, crude and a little vulgar) and **🔥 Anything goes**, which mixes in everything. The family-friendly mix never includes the adult pack.

The words live in `words.js` as `['Word', 'Quick definition']` pairs, so adding your own is one line each.

## Good to know


- **Refreshing or locking your phone is fine.** Each phone remembers its seat and rejoins automatically.
- **Late arrivals** can join mid-game and are added to the smaller team.
- **Someone left?** The host can remove them with ✕. Offline players are skipped when it's their turn.
- The host screen can **pause** or **skip** a turn if someone gets stuck.
- The host screen is sized for a TV: big type, a draining time bar across the top, and the whole layout scales with the screen.

## Development

```bash
npm test
```

- `game.js`: all the game rules and state, with no networking code
- `server.js`: Express and Socket.IO wiring
- `public/`: the browser client (host and phone views)
