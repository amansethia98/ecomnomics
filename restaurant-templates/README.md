# Restaurant starter bots

These files are used only when `RESTAURANT_STARTER_BOTS_ENABLED=true`.

Each folder is one bot. `bot.md` holds its name, one-line description, and instructions. A new restaurant gets its own copy of that text and can change the copy in the app.

`skills/<name>/SKILL.md` is a locked skill. It is not copied into the restaurant. Edit the file and restart the API and worker to update every restaurant. Restaurants can use the skill and cannot edit or delete it.

Add a bot by adding a folder with `bot.md`. Put locked skills that bot should follow under `skills/`. Keep folder names in lowercase letters, numbers, and hyphens.

`payouts` reconciles Zomato and Swiggy into one owner report. Its skill is locked. The bot text is the real instruction, not a placeholder.

`RESTAURANT_COMPUTER_ENABLED=true` gives each restaurant one computer shared by its bots. Leave both settings unset to keep ordinary self-hosted behavior. The computer still sleeps when idle (`SANDBOX_IDLE_MS`) and keeps its files.
