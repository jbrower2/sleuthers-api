\set ON_ERROR_STOP true
-- psql -U postgres -d sleuthers -a -f db-init.sql

DROP SCHEMA IF EXISTS sleuthers CASCADE;

CREATE SCHEMA sleuthers;
SET search_path TO sleuthers;

GRANT USAGE ON SCHEMA sleuthers TO "sleuthers-api";

ALTER DEFAULT PRIVILEGES IN SCHEMA sleuthers
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLES TO "sleuthers-api";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

SET TIMEZONE = 'UTC';


-- common function that sets the 'modified' field upon update
CREATE FUNCTION trigger_set_modified()
RETURNS trigger
LANGUAGE 'plpgsql'
AS $$
BEGIN
	NEW.modified = NOW();
	RETURN NEW;
END;
$$;


-- enum for different action types
CREATE TYPE action_type AS ENUM ('ROLL', 'MOVE', 'SIGHT', 'ELIMINATE', 'PICK_TOKEN', 'SPECIFIC_TOKEN');


-- enum for different game stages
CREATE TYPE game_stage AS ENUM ('PLAYING', 'GUESSING', 'FINISHED');


-- app user
CREATE TABLE app_user
(
    id             uuid         NOT NULL  DEFAULT uuid_generate_v4()  PRIMARY KEY,
    username       text         NOT NULL                              UNIQUE,
    password_hash  text         NOT NULL,
    created        timestamptz  NOT NULL  DEFAULT now(),
    modified       timestamptz  NOT NULL  DEFAULT now()
);

CREATE TRIGGER set_modified
BEFORE UPDATE ON app_user FOR EACH ROW
EXECUTE PROCEDURE trigger_set_modified();


-- collectible tokens
CREATE TABLE token
(
    id         uuid         NOT NULL  DEFAULT uuid_generate_v4()  PRIMARY KEY,
    name       text         NOT NULL,
    image_url  text         NOT NULL,
    created    timestamptz  NOT NULL  DEFAULT now(),
    modified   timestamptz  NOT NULL  DEFAULT now()
);

CREATE TRIGGER set_modified
BEFORE UPDATE ON token FOR EACH ROW
EXECUTE PROCEDURE trigger_set_modified();


-- game characters
CREATE TABLE character
(
	id         uuid         NOT NULL  DEFAULT uuid_generate_v4()  PRIMARY KEY,
	name       text         NOT NULL,
	bg_color   text         NOT NULL,
	image_url  text         NOT NULL,
    created    timestamptz  NOT NULL  DEFAULT now(),
    modified   timestamptz  NOT NULL  DEFAULT now()
);

CREATE TRIGGER set_modified
BEFORE UPDATE ON character FOR EACH ROW
EXECUTE PROCEDURE trigger_set_modified();


-- instances of a game
CREATE TABLE game
(
    id        uuid         NOT NULL  DEFAULT uuid_generate_v4()  PRIMARY KEY,
    owner     uuid         NOT NULL                              REFERENCES app_user (id),
    name      text         NOT NULL,
    stage     game_stage   NOT NULL  DEFAULT 'PLAYING',
    created   timestamptz  NOT NULL  DEFAULT now(),
    modified  timestamptz  NOT NULL  DEFAULT now()
);

CREATE TRIGGER set_modified
BEFORE UPDATE ON game FOR EACH ROW
EXECUTE PROCEDURE trigger_set_modified();


-- each user in a game, and the user state
CREATE TABLE game_user
(
    game        uuid      NOT NULL  REFERENCES game (id),
    app_user    uuid      NOT NULL  REFERENCES app_user (id),
	character   uuid      NOT NULL  REFERENCES character (id),
    game_order  smallint  NOT NULL,
    PRIMARY KEY (game, app_user)
);


-- each token type in a game, and the remaining count
CREATE TABLE game_token
(
    game   uuid      NOT NULL  REFERENCES game (id),
    token  uuid      NOT NULL  REFERENCES token (id),
    count  smallint  NOT NULL,
    PRIMARY KEY (game, token)
);


-- each token location on the board
CREATE TABLE game_token_location
(
    game      uuid      NOT NULL  REFERENCES game (id),
    token     uuid      NOT NULL  REFERENCES token (id),
    location  smallint  NOT NULL,
    PRIMARY KEY (game, token, location)
);


-- each token held by a user in a game
CREATE TABLE game_user_token
(
    game      uuid      NOT NULL  REFERENCES game (id),
    app_user  uuid      NOT NULL  REFERENCES app_user (id),
    token     uuid      NOT NULL  REFERENCES token (id),
    count     smallint  NOT NULL,
    PRIMARY KEY (game, app_user, token)
);


-- each character in a game, and the character state
CREATE TABLE game_character
(
    game        uuid      NOT NULL  REFERENCES game (id),
    character   uuid      NOT NULL  REFERENCES character (id),
	location    smallint  NOT NULL,
    eliminated  boolean   NOT NULL  DEFAULT FALSE,
    PRIMARY KEY (game, character)
);


-- each card in a game
CREATE TABLE game_card
(
    game        uuid         NOT NULL  REFERENCES game (id),
    id          uuid         NOT NULL  DEFAULT uuid_generate_v4()  UNIQUE,
    deck_order  smallint,
    action1     action_type  NOT NULL,
    character1  uuid                   REFERENCES character (id),
    token1      uuid                   REFERENCES token (id),
    action2     action_type  NOT NULL,
    character2  uuid                   REFERENCES character (id),
    token2      uuid                   REFERENCES token (id),
    PRIMARY KEY (game, id),
    FOREIGN KEY (game, character1) REFERENCES game_character (game, character),
    FOREIGN KEY (game, token1    ) REFERENCES game_token     (game, token    ),
    FOREIGN KEY (game, character2) REFERENCES game_character (game, character),
    FOREIGN KEY (game, token2    ) REFERENCES game_token     (game, token    ),
    CONSTRAINT chk_sight1 CHECK ((action1 = 'SIGHT') = (character1 IS NOT NULL)),
    CONSTRAINT chk_specific_token1 CHECK ((action1 = 'SPECIFIC_TOKEN') = (token1 IS NOT NULL)),
    CONSTRAINT chk_sight2 CHECK ((action2 = 'SIGHT') = (character2 IS NOT NULL)),
    CONSTRAINT chk_specific_token2 CHECK ((action2 = 'SPECIFIC_TOKEN') = (token2 IS NOT NULL))
);


-- each card in a user's hand
CREATE TABLE game_user_card
(
    game      uuid  NOT NULL  REFERENCES game (id),
    card      uuid  NOT NULL  REFERENCES game_card (id),
    app_user  uuid  NOT NULL  REFERENCES app_user (id),
    PRIMARY KEY (game, card, app_user),
    FOREIGN KEY (game, card) REFERENCES game_card (game, id)
);


-- each guess that a user makes
CREATE TABLE game_user_guess
(
    game         uuid     NOT NULL  REFERENCES game (id),
    app_user     uuid     NOT NULL  REFERENCES app_user (id),
    character    uuid     NOT NULL  REFERENCES character (id),
    target_user  uuid     NOT NULL  REFERENCES app_user (id),
    guess        boolean  NOT NULL,
    PRIMARY KEY (game, app_user, character, target_user),
    FOREIGN KEY (game, app_user) REFERENCES game_user (game, app_user),
    FOREIGN KEY (game, character) REFERENCES game_character (game, character),
    FOREIGN KEY (game, target_user) REFERENCES game_user (game, app_user)
);


-- each action that happens in a game
CREATE TABLE game_log
(
    game                 uuid         NOT NULL  REFERENCES game (id),
    id                   smallint     NOT NULL,
    time                 timestamptz  NOT NULL  DEFAULT now(),
    app_user             uuid         NOT NULL  REFERENCES app_user (id),
    action               action_type  NOT NULL,
    die1                 uuid                   REFERENCES character (id),
    die2                 uuid                   REFERENCES character (id),
    card                 uuid                   REFERENCES game_card (id),
    character            uuid                   REFERENCES character (id),
    token                uuid                   REFERENCES token (id),
    move_from            smallint,
    sight_result         boolean,
    sight_user           uuid                   REFERENCES app_user (id),
    PRIMARY KEY (game, id),
    FOREIGN KEY (game, card) REFERENCES game_card (game, id),
    CONSTRAINT chk_character CHECK ((action IN ('MOVE', 'SIGHT', 'ELIMINATE')) = (character IS NOT NULL)),
    CONSTRAINT chk_move_from CHECK ((action = 'MOVE') = (move_from IS NOT NULL)),
    CONSTRAINT chk_sight_result CHECK ((action = 'SIGHT') = (sight_result IS NOT NULL)),
    CONSTRAINT chk_sight_user CHECK ((action = 'SIGHT') = (sight_user IS NOT NULL)),
    CONSTRAINT chk_token CHECK ((action IN ('PICK_TOKEN', 'SPECIFIC_TOKEN')) = (token IS NOT NULL))
);


-- TEST DATA
INSERT INTO app_user(id, username, password_hash) VALUES('4aa8c716-dc0b-4831-b4a7-5cbf6ab9889a', 'jeff'  , '$2b$10$N.l6GS5uOSs7PEtJ1QeDJe9tKjjGEgIr4KsvpBriLPqaUiCbuMcsC');
INSERT INTO app_user(id, username, password_hash) VALUES('695c1cb8-6868-4d82-8c96-0d1e068c628a', 'cassie', '$2b$10$tb8CHEGCbS5XiDstC9zp3OgaVz8bD0hW1N9TOiHqBIB1rMLZtnPZi');
INSERT INTO app_user(id, username, password_hash) VALUES('9dd17861-67a0-4c0f-bca9-8a4426da98e5', 'jimmy' , '$2b$10$qT4IOqKawtFVp/nX1UXNvOiMW21V1ow638lXGUqRlKTHjXEkVAfja');
INSERT INTO app_user(id, username, password_hash) VALUES('e63ea5c9-396f-4d79-879f-838ec6719191', 'tommy' , '$2b$10$1JR/YfVzI.KjBkvCGtQ..OUbtcgwRIEldAGLv/rjuVmyy2Zic3.DK');

INSERT INTO token(id, name, image_url) VALUES('5df859ba-791f-411a-838d-f7615a7b3e17', 'diamond', 'diamond.png');
INSERT INTO token(id, name, image_url) VALUES('3022189f-3702-4678-a16d-0eea5fbbcc74', 'ruby'   , 'ruby.png'   );
INSERT INTO token(id, name, image_url) VALUES('a41fda70-5b68-4ded-940a-63f8ae7ac987', 'emerald', 'emerald.png');

INSERT INTO character(id, name, bg_color, image_url) VALUES('53b104c4-15cc-411f-bd68-97c84d200b20', 'Mildred Wellington' , '#b4be35', 'mildred-wellington.png' );
INSERT INTO character(id, name, bg_color, image_url) VALUES('6062b068-48b7-4aa5-81bf-5a137a936ba9', 'Remy La Rocque'     , '#bdbbbb', 'remy-la-rocque.png'     );
INSERT INTO character(id, name, bg_color, image_url) VALUES('2b2cc145-937b-49d0-ad10-67aa51f2eda2', 'Trudie Mudge'       , '#0082b5', 'trudie-mudge.png'       );
INSERT INTO character(id, name, bg_color, image_url) VALUES('9a9de24b-05ab-4181-92d1-dbc4cdb0287a', 'Buford Barnswallow' , '#fae300', 'buford-barnswallow.png' );
INSERT INTO character(id, name, bg_color, image_url) VALUES('ba4fea2c-cf3b-4be0-8252-73cf77f873e8', 'Viola Chung'        , '#d9272d', 'viola-chung.png'        );
INSERT INTO character(id, name, bg_color, image_url) VALUES('d2ed6bb6-134d-4655-ba57-1adb8de316a1', 'Earl of Volesworthy', '#672e6b', 'earl-of-volesworthy.png');
INSERT INTO character(id, name, bg_color, image_url) VALUES('e0908190-3e04-402a-95c3-34993097d31c', 'Nadia Bwalya'       , '#ffffff', 'nadia-bwalya.png'       );
INSERT INTO character(id, name, bg_color, image_url) VALUES('a9bcf5d2-71bf-4d32-8de2-dec571768424', 'Dr. Ashraf Najem'   , '#f5a81c', 'dr-ashraf-najem.png'    );
INSERT INTO character(id, name, bg_color, image_url) VALUES('e9f2b5d7-514e-4f18-9e18-67a02afecc56', 'Lily Nesbitt'       , '#f8baca', 'lily-nesbitt.png'       );
INSERT INTO character(id, name, bg_color, image_url) VALUES('07817c98-5d35-4acf-aa67-d9bb5caab84b', 'Stefano Laconi'     , '#ba772a', 'stefano-laconi.png'     );
