# Buzzers
Have you ever wanted to run a gameshow for up to 30 other people, but never had the buzzers? 
Now you do.

This is mainly built for running live You Dont Know Jack games, and I do think you *could* do jeopardy, but there are *way* better options for that, again, this is built for multiple choice option quiz games with a slide deck showing the questions and options or just as john buzzer.

But wait! isnt this just kahoot? I hear you ask! yes and no, yes it does follow the same format on player's end, but this is SUPER customisable, scoring, disable certain players, maximum of 6 options, again, this is built for live YDKJ games, where there is more comedy then questions, it also does require an external slide deck for showing questions, but now includes a score sheet/general display for the side of your slideshow.

## FAQ

### You said this is made for YDKJ games, Is there a "F*** You" easter egg?
Yes. yes there is, handwritten response too, try it, I dare ya

### My players are being evil
Screw em'

### Support for jack attack rounds? 
I dont know how this could work with how I made this so yea, if you want to take a crack at it, open a PR, i'd love to see it. although if you set it to 6-choice mode, something like Full Stream would be possible

### Whats on said slide deck?
Music, Questions, eveything exept a scoreboard, who buzzed etc.

### The player controller sucks!
Thanks captain obvious, I was mainly on the configurablily of everything (seriously, go look at the options)

### Can we have all in one instead of requiring a slideshow?
No. at least not now, I do see the idea of one in the distant future, but thats when I decide, it would probably look like a question creator menu in a separate area (another main menu button) which lets you make a set there, then you import when creating a lobby.

### Whats coming?
Better UI, disordat support, roadkill, and more round types.

### How make work?
Just run the thing as you would a node app, or just use the vercel instance [Here](https://instant-buzzers-playroom.vercel.app/)

USE NODE 20+

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
I am currently trying to learn node.js, and this was a project I decided to make, as I saw a possibility of this being useful, then added more and more then thought "wait this is actually kinda neat". this is mostly vibe-coded in its current state (github copilot and opencode), this was to serve as an example for me later on. I probably will de-vibe it later, with a better UI, and stuff like that. No promises tho as I am super lazy. Still adding new features using AI at this time, and dont worry, I dont YOLO ai code instantly, I test it out, make sure it works, then fix it myself if I have to. Also, I work on this in week long phases, where a lot gets added then I leave it be for a month or two, If there is a feature you want to add in, fork, make, PR.

Built on playroom kit and nodejs
