# Buzzers
Have you ever wanted to run a gameshow for up to 30 other people, but never had the buzzers? 
Now you do.

This is mainly built for running live You Dont Know Jack games, and I do think you *could* do jeopardy, but there are *way* better options for that, again, this is built for multiple choice option quiz games with a slide deck showing the questions and options. 

But wait! isnt this just kahoot? I hear you ask, yes and no, yes it does follow the same format on player's end, but this is SUPER customisable, again, this is built for live YDKJ games, where there is more comedy then questions it does require an external slide deck for showing questions, and has no player group display (yet) but again, this is just buzzers, what more do you want.

Where is room code? Top Left, You can miss it

Built on playroom kit and nodejs
Just run the thing as you would a node app, ive only tested it on Linux Mint and Kubuntu, so idk if it will work on windows, or just use the vercel instance [Here](https://instant-buzzers-playroom.vercel.app/)

## How make work?

USE NODE 20+
(I used the latest lts (v24.15.0 at time of writing) and it worked for me)

### Setup:
```
npm install
```

### Development server:
```
npm run dev
```

### Set up for running on YOUR server (if vercel not worky)
```
npm run build
```

## AI disclamer:
I am currently trying to learn node.js, and this was a project I decided to make, this is mostly vibe-coded in its current state, this was to serve as an example for me later on. I probably will de-vibe it later, with a better UI, more secure backend etc. No promises tho as I am super lazy
