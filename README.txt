#Driver Check-In

This project uses ONE local SQLite database shared by the driver check-in form and the checked-in driver list.

Files:
- admin.html
- form.html
- list.html
- server.js
- package.json

Comand:
npm install <-- for dependencies
npm start <-- to start
npm stop  <-- to stop
npm restart <--to restart

Then open:
http://localhost:8000/index.html <-- changed it to your local ipv4. edit this in server.js
http://localhost:8000/admin.html <-- to add orders that can check in, ADMIN PANEL

The database is:
better-sqlite3
database.db

Default PIN : 1234

