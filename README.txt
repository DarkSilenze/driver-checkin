#Driver Check-In

This project uses ONE local SQLite database shared by the driver check-in form and the checked-in driver list.

Files:
- admin.html
- form.html
- list.html
- server.js
- package.json

Comand:
mkdir driver-checkin
cd driver-checkin
npm install <-- for dependencies
npm start <-- to start


Then open:
http://localhost:1127/index.html <-- changed it to your local ipv4. edit this in server.js

The database is:
better-sqlite3
database.db

Default login: admin / admin123
Default PIN : 1234

