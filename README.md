# Buzzers
Have you ever wanted to run a gameshow for up to 30 other people, but never had the buzzers? 
Now you do.

This is mainly built for running live You Dont Know Jack games, and I do think you *could* do jeopardy, but there are *way* better options for that, again, this is built for multiple choice option quiz games with a slide deck showing the questions and options or just as john buzzer if its in 1 buzzer mode.

But wait! isnt this just kahoot? I hear you ask! yes and no (see "why?" in the FAQ), yes it does follow the same format on player's end, but this is SUPER customisable, scoring, disable certain players, maximum of 6 options, heck I have BINGO and wendithappn again, this is built for live YDKJ games, where there is more comedy then questions, it also does require an external slide deck for showing questions, but includes a score sheet/general display for the side of your slideshow.

## FAQ

### You said this is made for YDKJ games, Is there a "F*** You" easter egg?
Yes. yes there is, handwritten response too, try it, I dare ya

### My players are being evil
Screw em'

### Support for jack attack rounds? 
I don't know how this could work with how I made this so yea, if you want to take a crack at it, open a PR, i'd love to see it. although if you set it to 6-choice mode, something like Full Stream would be possible.

### Whats on said slide deck?
Music, Questions, everything except a scoreboard, who buzzed etc.

### The player controller sucks!
Thanks captain obvious, I was mainly on the configurability of everything (seriously, go look at the options), now yes, this controller is reminicent of YDKJ2015's but hey, what else could I do?

### Can we have all in one instead of requiring a slideshow?
No. at least not now, I do see the idea of one in the distant future, but thats when I decide, it would probably look like a question creator menu in a separate area (another main menu button) which lets you make a set there, then you import when creating a lobby.

### Alright, where is the snark in the messages
You need to enable it in the settings, please read [This file](/src/snark.json) before turning on snark

### What's coming?
In no particular order,\
Better UI, fibbage mode, more round types, whatever people ask via creating issues and ~~whatever I think of the next time I shower~~ other cool stuff.

### How do you decide what to add?
Whatever I decide to add, gets added, if there is a second branch, usually the name will say what I am adding, and there is almost always a few random qol and bug fixes changes added in as well

### Tutorial?
Soon!

#### Video tutorial?
Possibly.

### How much experience with JACK would you recommend to understand the lingo
play a few episodes of the [re-ride](https://thereri.de) (use the unlock all feature and play a few at random) and you should understand enough, you probably shouldn't go for it as the style of your presentation.\
You can also just... not, your choice

### Speaking of themes... what would you recommend
I'm planning to re-create the 2011/2015 games for my ui theme here... when I get around to it... eventually... probably...

### Complete feature list?
(breathes in) 
- 1,2,4,6 response multiple choice questions with the ability to toggle specific answers on and off
- Text response mode for gibberish/anagram questions (or lame fill in the blanks)
- Dis or Dats
- Bingo
- Wen dit happ'n
- Audience display
- Timer display for host companion devices
- Co-hosting
- SCREWS
- F*** You easter egg
- Team mode (share buzzer across multiple devices)
- Alliance mode (lump scores together)
- You or players can create the teams (up to 8 teams, and you can add a player limit)
- 42 Player cap.
- Three separate scoring modes (Uniform, JACK, and Pick-a-value)
- Organized labeled menu
- Handwritten snark
- ADHD stream-of-consciousness made README and eventual tutorial on how to use.
- PWA support
- and probably more (soon!)

### Why?
Because jackbox doesn't have a large player count easily moddable version of JACK that I could use, and kahoot & similar pissed me off with the free limits or lack of variety.

### How can I ask for stuff?
Right now? Just create an issue, I might set up some google form or something like that down the line

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
### Development server but actually using a network (for multi device testing):
```
npm run dev-server
```

### Set up for running on YOUR server (if vercel no worky)
```
npm run build
```

## AI disclamer:
I am currently trying to learn node.js, and this was a project I decided to make, as I saw a possibility of this being useful, then added more and more then thought "wait this is actually kinda neat".\
This is mostly vibe-coded in its current state (github copilot and opencode), this was to serve as an example for me later on. I probably will de-vibe it later, with a better UI, and stuff like that. No promises tho as I am super lazy.\
Still adding new features using AI at this time, and dont worry, I dont YOLO ai code instantly, I test it out, make sure it works, then fix it myself if I have to. Also, I work on this in phases, where a lot gets added then I leave it be for a month or two, If there is a feature you want to add in, fork, make, PR, I read my emails.

Built on playroom kit and nodejs
