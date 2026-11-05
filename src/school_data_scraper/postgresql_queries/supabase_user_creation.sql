/*
----------- Database User (Read Only) ---------------------

1. Create Read-Only User:

CREATE ROLE frc_reader
LOGIN
PASSWORD 'StrongPassword123';

2. Give  Permissions:

GRANT CONNECT ON DATABASE postgres TO frc_reader;

GRANT USAGE ON SCHEMA public TO frc_reader;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO frc_reader;

3. Future Table Permission:

ALTER DEFAULT PRIVILEGES
IN SCHEMA public
GRANT SELECT ON TABLES TO frc_reader;


----------- Database User (Developer) ---------------------

1. Create User for Dev:

CREATE ROLE frc_dev
LOGIN
PASSWORD 'StrongPassword456';

2. Grant permissions:

GRANT CONNECT ON DATABASE postgres TO frc_dev;
GRANT USAGE ON SCHEMA public TO frc_dev;

GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA public
TO frc_dev;

3. Default permissions:

ALTER DEFAULT PRIVILEGES
IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLES TO frc_dev;  */
