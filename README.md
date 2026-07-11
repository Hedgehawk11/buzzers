# Buzzers
Have you ever wanted to run a gameshow for up to 30 other people, but never had the buzzers? 
Now you do.

This is mainly built for running live You Dont Know Jack games, and I do think you *could* do jeopardy, but there are *way* better options for that, again, this is built for multiple choice option quiz games with a slide deck showing the questions and options or just as john buzzer.

But wait! isnt this just kahoot? I hear you ask! yes and no, yes it does follow the same format on player's end, but this is SUPER customisable, scoring, disable certain players, maximum of 6 options, again, this is built for live YDKJ games, where there is more comedy then questions, it also does require an external slide deck for showing questions, but now includes a score sheet/general display for the side of your slideshow.

## FAQ
### Where is room code?
Top Left, You can miss it

### You said this is made for YDKJ games, Is there a "F*** You" easter egg?
Yes. yes there is, handwritten responce too, try it, I dare ya

### Support for jack attack rounds? 
I dont know how this could work with how I made this so yea, if you want to take a jack at it, open a PR, i'd love to see it. although if you set it to 6-choice mode, something like Full Stream might be possible

### Whats on said slide deck?
Music, Questions, eveything exept a scoreboard, who buzzed etc.

### The audience display and player controller sucks!
Thanks captain obvious, i was mainly on the configurablily of everything (seriously, go look at the options)

### Whats coming?
Better disordat support, bingo, roadkill, (Can you tell I like the Ride) etc.

### How make work?
Just run the thing as you would a node app, ive only tested it on Linux Mint and Kubuntu, so idk if it will work on windows, or just use the vercel instance [Here](https://instant-buzzers-playroom.vercel.app/)

USE NODE 20+
(I used v24.15.0 and that seemed to work)

### Setup:
```
npm install
```

### Development server:
```
npm run dev
```

### Set up for running on YOUR server (if vercel no worky)
```
npm run build
```

## AI disclamer:
I am currently trying to learn node.js, and this was a project I decided to make, this is mostly vibe-coded in its current state, this was to serve as an example for me later on. I probably will de-vibe it later, with a better UI, and stuff like that. No promises tho as I am super lazy. Still adding new features using AI at this time.

Built on playroom kit and nodejs
