import bcrypt from "bcrypt";
import bodyParser from "body-parser";
import cors from "cors";
import express, { Request, Response } from "express";
import { readFileSync } from "fs";
import passport from "passport";
import { BasicStrategy } from "passport-http";
import { Client, ClientConfig } from "pg";

const port = 3000;

class ErrorResponse {
  constructor(public status: number, public message: string) {}
}

type GameIdPathParam = { gameId: string };

type ActionType =
  | "ROLL"
  | "MOVE"
  | "SIGHT"
  | "ELIMINATE"
  | "PICK_TOKEN"
  | "SPECIFIC_TOKEN";

type GameStage = "PLAYING" | "GUESSING" | "FINISHED";

type ActionRequest = {
  type: ActionType;
  cardId?: string;
  characterId?: string;
  tokenId?: string;
  moveTo?: number;
  sightUserId?: string;
};

type GuessDeleteRequest = {
  characterId: string;
  userId: string;
};

type GuessPostRequest = GuessDeleteRequest & {
  characterId: string;
  userId: string;
  guess: boolean;
};

type AppUserTable = {
  id: string;
  username: string;
  password_hash: string;
  created: Date;
  modified: Date;
};

type TokenTable = {
  id: string;
  name: string;
  image_url: string;
  created: Date;
  modified: Date;
};

type CharacterTable = {
  id: string;
  name: string;
  bg_color: string;
  image_url: string;
  created: Date;
  modified: Date;
};

type GameTable = {
  id: string;
  owner: string;
  name: string;
  stage: GameStage;
  created: Date;
  modified: Date;
};

type GameUserTable = {
  game: string;
  app_user: string;
  character: string;
  game_order: number;
};

type GameTokenTable = {
  game: string;
  token: string;
  count: number;
};

type GameTokenLocationTable = {
  game: string;
  token: string;
  location: number;
};

type GameUserTokenTable = {
  game: string;
  app_user: string;
  token: string;
  count: number;
};

type GameCharacterTable = {
  game: string;
  character: string;
  location: number;
  eliminated: boolean;
};

type GameCardTable = {
  game: string;
  id: string;
  deck_order?: number;
  action1: ActionType;
  character1?: string;
  token1?: string;
  action2: ActionType;
  character2?: string;
  token2?: string;
};

type GameUserCardTable = {
  game: string;
  card: string;
  app_user: string;
};

type GameUserGuessTable = {
  game: string;
  app_user: string;
  character: string;
  target_user: string;
  guess: boolean;
};

type GameLogTable = {
  game: string;
  id: number;
  time: Date;
  app_user: string;
  action: ActionType;
  die1?: string;
  die2?: string;
  card?: string;
  character?: string;
  token?: string;
  move_from?: number;
  sight_result?: boolean;
  sight_user?: string;
};

const handleResponse = (f: (req: Request) => Promise<any | unknown>) => async (
  req: Request,
  res: Response
) => {
  try {
    res.send(await f(req));
  } catch (e) {
    console.error(e);
    if (e instanceof ErrorResponse) {
      res.status(e.status).send(e.message);
    } else {
      res.status(500).send(e);
    }
  }
};

const shuffle = <T>(arr: T[]): void => {
  const n = arr.length;
  for (let i = 0; i < n; i++) {
    const j = Math.floor(Math.random() * n);
    if (i !== j) {
      const temp = arr[i];
      arr[i] = arr[j];
      arr[j] = temp;
    }
  }
};

const rollDice = (characters: string[]): [string | null, string | null] => {
  shuffle(characters);
  return [
    Math.random() < 1 / 6 ? null : characters[0],
    Math.random() < 1 / 6 ? null : characters[1],
  ];
};

const isFinished = async (db: Client, gameId: string) => {
  const { rows: users } = await db.query<GameUserTable & AppUserTable>(
    `SELECT *
       FROM sleuthers.game_user
       JOIN sleuthers.app_user
         ON game_user.app_user = app_user.id
      WHERE game = $1
      ORDER BY game_order`,
    [gameId]
  );

  const { rows: userGuesses } = await db.query<GameUserGuessTable>(
    `SELECT *
       FROM sleuthers.game_user_guess
      WHERE game = $1`,
    [gameId]
  );

  for (const user of users) {
    for (const targetUser of users) {
      if (targetUser.id === user.id) {
        continue;
      }
      const guessCount = userGuesses.filter(
        (userGuess) =>
          userGuess.app_user === user.id &&
          userGuess.target_user === targetUser.id &&
          userGuess.guess
      ).length;
      if (guessCount !== 1) {
        return false;
      }
    }
  }

  return true;
};

(async () => {
  const db = new Client(
    JSON.parse(readFileSync("db.config", "utf8")) as ClientConfig
  );
  await db.connect();

  passport.use(
    new BasicStrategy(async (username, password, done) => {
      try {
        const { rows } = await db.query<AppUserTable>(
          `SELECT *
             FROM sleuthers.app_user
            WHERE username = $1`,
          [username]
        );

        if (rows.length !== 1) {
          return done(null, false);
        }

        if (!bcrypt.compareSync(password, rows[0].password_hash)) {
          return done(null, false);
        }

        return done(null, rows[0]);
      } catch (e) {
        console.error(e);
        return done("Error during authentication", false);
      }
    })
  );
  const basicAuth = passport.authenticate("basic", { session: false });

  const app = express();

  app.use(passport.initialize());
  app.use(cors());
  app.use(bodyParser.json({ type: "application/json" }));

  ////////////////////////////////////////////////////////////////
  // get all of a user's games
  ////////////////////////////////////////////////////////////////
  // TODO implement caching with http If-Modified-Since
  app.get(
    "/game",
    basicAuth,
    handleResponse(async (req) => {
      const authUser = req.user as AppUserTable;
      const { rows: games } = await db.query<GameTable>(
        `SELECT *
           FROM sleuthers.game
          WHERE id IN (
            SELECT game
              FROM sleuthers.game_user
             WHERE app_user = $1
          )`,
        [authUser.id]
      );
      return games.map((game) => {
        // TODO add game details
        return {
          id: game.id,
          name: game.name,
        };
      });
    })
  );

  ////////////////////////////////////////////////////////////////
  // create a new game, with the user as the owner
  ////////////////////////////////////////////////////////////////
  app.put(
    "/game",
    basicAuth,
    handleResponse(async (req) => {
      const authUser = req.user as AppUserTable;
      const { name, userIds } = req.body;
      if (!name) {
        throw new ErrorResponse(400, "`name` is required");
      }
      if (!userIds?.length) {
        throw new ErrorResponse(400, "`userIds` are required");
      }
      for (const userId of userIds) {
        const { rows } = await db.query<never>(
          `SELECT 1
             FROM sleuthers.app_user
            WHERE id = $1`,
          [userId]
        );
        if (!rows.length) {
          throw new ErrorResponse(404, `User ${userId} not found`);
        }
      }

      // insert into game table
      const {
        rows: [{ id: gameId }],
      } = await db.query<{ id: string }>(
        `INSERT INTO sleuthers.game(owner, name)
                             VALUES($1   , $2  ) RETURNING id`,
        [authUser.id, name]
      );

      // calculate token count based on player count
      const playerCount = userIds.length;
      if (playerCount < 2 || playerCount > 6) {
        throw new ErrorResponse(
          400,
          `Player count must be 2-6: ${playerCount}`
        );
      }

      const tokenCount = playerCount + 2;

      // array of all cards
      const cards: Partial<GameCardTable>[] = [
        {
          action1: "PICK_TOKEN",
          action2: "MOVE",
        },
        {
          action1: "PICK_TOKEN",
          action2: "ELIMINATE",
        },
      ];

      // insert into game_token
      const tokens = [
        "5df859ba-791f-411a-838d-f7615a7b3e17",
        "3022189f-3702-4678-a16d-0eea5fbbcc74",
        "a41fda70-5b68-4ded-940a-63f8ae7ac987",
      ];
      const tokenLocations = [
        [1, 2, 4, 6, 7, 8, 11],
        [0, 1, 3, 5, 6, 8, 10],
        [2, 3, 4, 5, 9, 10, 11],
      ];
      for (let i = 0; i < tokens.length; i++) {
        const tokenId = tokens[i];
        cards.push(
          {
            action1: "SPECIFIC_TOKEN",
            token1: tokenId,
            action2: "MOVE",
          },
          {
            action1: "SPECIFIC_TOKEN",
            token1: tokenId,
            action2: "ELIMINATE",
          }
        );

        await db.query<never>(
          `INSERT INTO sleuthers.game_token(game, token, count)
                                     VALUES($1  , $2   , $3   )`,
          [gameId, tokenId, tokenCount]
        );

        for (const l of tokenLocations[i]) {
          await db.query<never>(
            `INSERT INTO sleuthers.game_token_location(game, token, location)
                                                VALUES($1  , $2   , $3      )`,
            [gameId, tokenId, l]
          );
        }
      }

      // insert into game_character
      const characters = [
        "53b104c4-15cc-411f-bd68-97c84d200b20",
        "6062b068-48b7-4aa5-81bf-5a137a936ba9",
        "2b2cc145-937b-49d0-ad10-67aa51f2eda2",
        "9a9de24b-05ab-4181-92d1-dbc4cdb0287a",
        "ba4fea2c-cf3b-4be0-8252-73cf77f873e8",
        "d2ed6bb6-134d-4655-ba57-1adb8de316a1",
        "e0908190-3e04-402a-95c3-34993097d31c",
        "a9bcf5d2-71bf-4d32-8de2-dec571768424",
        "e9f2b5d7-514e-4f18-9e18-67a02afecc56",
        "07817c98-5d35-4acf-aa67-d9bb5caab84b",
      ];

      // roll dice for first turn
      const [die1, die2] = rollDice(characters);

      // insert log record for dice roll
      await db.query<never>(
        `INSERT INTO sleuthers.game_log(game, id, app_user, action, die1, die2)
                                 VALUES($1  , 0 , $2      , 'ROLL', $3  , $4  )`,
        [gameId, userIds[0], die1, die2]
      );

      // different cards each time
      shuffle(characters);

      for (let i = 0; i < characters.length; i++) {
        cards.push(
          {
            action1: "PICK_TOKEN",
            action2: "SIGHT",
            character2: characters[i],
          },
          {
            action1: i % 2 === 0 ? "MOVE" : "ELIMINATE",
            action2: "SIGHT",
            character2: characters[i],
          }
        );
      }

      // different starting position each time
      shuffle(characters);

      for (let i = 0; i < characters.length; i++) {
        const location = i < 5 ? i : i + 2;
        await db.query<never>(
          `INSERT INTO sleuthers.game_character(game, character, location)
                                         VALUES($1  , $2       , $3      )`,
          [gameId, characters[i], location]
        );
      }

      // shuffle deck
      shuffle(cards);

      // insert into game_card
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const {
          action1,
          character1,
          token1,
          action2,
          character2,
          token2,
        } = card;
        const {
          rows: [{ id: cardId }],
        } = await db.query<{ id: string }>(
          `INSERT INTO sleuthers.game_card(game, deck_order, action1, character1, token1, action2, character2, token2)
                                    VALUES($1  , $2        , $3     , $4        , $5    , $6     , $7        , $8    ) RETURNING id`,
          [gameId, i, action1, character1, token1, action2, character2, token2]
        );
        card.id = cardId;
      }

      // different player position each time
      shuffle(characters);

      // insert into game_user and game_user_card
      for (let i = 0; i < userIds.length; i++) {
        const userId = userIds[i];
        await db.query<never>(
          `INSERT INTO sleuthers.game_user(game, app_user, character, game_order)
                                    VALUES($1  , $2      , $3       , $4        )`,
          [gameId, userId, characters[i], i]
        );

        // two cards
        for (let j = 0; j < 2; j++) {
          const { id: cardId } = cards.pop()!;
          await db.query<never>(
            `UPDATE sleuthers.game_card
                SET deck_order = NULL
              WHERE id = $1`,
            [cardId]
          );
          await db.query<never>(
            `INSERT INTO sleuthers.game_user_card(game, card, app_user)
                                           VALUES($1  , $2  , $3      )`,
            [gameId, cardId, userId]
          );
        }
      }

      return gameId;
    })
  );

  ////////////////////////////////////////////////////////////////
  // get the game state that is visible to the user
  ////////////////////////////////////////////////////////////////
  // TODO implement caching with http If-Modified-Since
  app.get<GameIdPathParam>(
    "/game/:gameId",
    basicAuth,
    handleResponse(async (req) => {
      const { gameId } = req.params;
      const authUser = req.user as AppUserTable;

      const { rows: gameRows } = await db.query<GameTable>(
        `SELECT *
           FROM sleuthers.game
          WHERE id = $1`,
        [gameId]
      );
      if (!gameRows.length) {
        throw new ErrorResponse(404, `Game ${gameId} not found`);
      }
      if (gameRows.length > 1) {
        throw new ErrorResponse(400, `Duplicate game ${gameId}`);
      }
      const [game] = gameRows;

      const { rows: users } = await db.query<GameUserTable & AppUserTable>(
        `SELECT *
           FROM sleuthers.game_user
           JOIN sleuthers.app_user
             ON game_user.app_user = app_user.id
          WHERE game = $1
          ORDER BY game_order`,
        [gameId]
      );

      for (let i = 0; i < users.length; i++) {
        if (users[i].game_order !== i) {
          throw "Bad user state";
        }
      }

      if (!users.find((user) => user.id === authUser.id)) {
        throw new ErrorResponse(404, `Game ${gameId} not found`);
      }

      const { rows: tokens } = await db.query<GameTokenTable & TokenTable>(
        `SELECT *
           FROM sleuthers.game_token
           JOIN sleuthers.token
             ON game_token.token = token.id
          WHERE game = $1`,
        [gameId]
      );

      const { rows: tokenLocations } = await db.query<GameTokenLocationTable>(
        `SELECT *
           FROM sleuthers.game_token_location
          WHERE game = $1`,
        [gameId]
      );

      const { rows: userTokens } = await db.query<GameUserTokenTable>(
        `SELECT *
           FROM sleuthers.game_user_token
          WHERE game = $1`,
        [gameId]
      );

      const { rows: characters } = await db.query<
        GameCharacterTable & CharacterTable
      >(
        `SELECT *
           FROM sleuthers.game_character
           JOIN sleuthers.character
             ON game_character.character = character.id
          WHERE game = $1`,
        [gameId]
      );

      const { rows: userCards } = await db.query<
        GameUserCardTable & GameCardTable
      >(
        `SELECT *
           FROM sleuthers.game_user_card
           JOIN sleuthers.game_card
             ON game_user_card.game = game_card.game
            AND game_user_card.card = game_card.id
          WHERE game_card.game = $1`,
        [gameId]
      );

      const { rows: userGuesses } = await db.query<GameUserGuessTable>(
        `SELECT *
           FROM sleuthers.game_user_guess
          WHERE game = $1`,
        [gameId]
      );

      const { rows: log } = await db.query<GameLogTable>(
        `SELECT *
           FROM sleuthers.game_log
          WHERE game = $1
          ORDER BY id`,
        [gameId]
      );
      if (!log.length) {
        throw "Illegal state";
      }

      const lastPlayerId = log[log.length - 1].app_user;
      const turnCount = (() => {
        let count = 1;
        while (
          count < log.length &&
          log[log.length - count - 1].app_user === lastPlayerId
        ) {
          count++;
        }
        return count;
      })();
      const curPlayerOrder = users.find((user) => user.id === lastPlayerId)!
        .game_order;
      const curPlayer = users[curPlayerOrder];

      return {
        name: game.name,
        stage: game.stage,
        users: users.reduce(
          (obj, user) => ({
            ...obj,
            [user.id]: {
              username: user.username,
              gameOrder: user.game_order,
              tokens: userTokens
                .filter((userToken) => userToken.app_user === user.id)
                .reduce(
                  (obj, userToken) => ({
                    ...obj,
                    [userToken.token]: userToken.count,
                  }),
                  {}
                ),
              ...(user.id === curPlayer.id && { cur: true, turnCount }),
              ...(authUser.id === user.id && {
                self: true,
                character: user.character,
                cards: userCards
                  .filter((userCard) => userCard.app_user === user.id)
                  .reduce(
                    (obj, userCard) => ({
                      ...obj,
                      [userCard.card]: {
                        action1: {
                          type: userCard.action1,
                          ...(userCard.action1 === "SIGHT" && {
                            character1: userCard.character1,
                          }),
                          ...(userCard.action1 === "SPECIFIC_TOKEN" && {
                            token1: userCard.token1,
                          }),
                        },
                        action2: {
                          type: userCard.action2,
                          ...(userCard.action2 === "SIGHT" && {
                            character2: userCard.character2,
                          }),
                          ...(userCard.action2 === "SPECIFIC_TOKEN" && {
                            token2: userCard.token2,
                          }),
                        },
                      },
                    }),
                    {}
                  ),
              }),
              ...((authUser.id === user.id || game.stage === "FINISHED") && {
                guesses: userGuesses
                  .filter((userGuess) => userGuess.app_user === user.id)
                  .reduce((obj, userGuess) => {
                    (obj[userGuess.target_user] ||
                      (obj[userGuess.target_user] = {}))[userGuess.character] =
                      userGuess.guess;
                    return obj;
                  }, {} as any),
              }),
            },
          }),
          {}
        ),
        characters: characters.reduce(
          (obj, character) => ({
            ...obj,
            [character.id]: {
              name: character.name,
              location: character.location,
              bgColor: character.bg_color,
              imageUrl: character.image_url,
            },
          }),
          {}
        ),
        tokens: tokens.reduce(
          (obj, token) => ({
            ...obj,
            [token.id]: {
              name: token.name,
              count: token.count,
              imageUrl: token.image_url,
              locations: tokenLocations
                .filter((tokenLocation) => tokenLocation.token === token.id)
                .map((tokenLocation) => tokenLocation.location),
            },
          }),
          {}
        ),
        log: log.map((logEntry) => ({
          user: logEntry.app_user,
          time: logEntry.time,
          action: logEntry.action,
          ...(logEntry.card && { card: logEntry.card }),
          ...(logEntry.action === "ROLL" && {
            ...(logEntry.die1 && { die1: logEntry.die1 }),
            ...(logEntry.die2 && { die2: logEntry.die2 }),
          }),
          ...(logEntry.action === "MOVE" && {
            character: logEntry.character,
            moveFrom: logEntry.move_from,
          }),
          ...(logEntry.action === "SIGHT" && {
            character: logEntry.character,
            ...(authUser.id === logEntry.app_user && {
              sightResult: logEntry.sight_result,
            }),
            sightUser: logEntry.sight_user,
          }),
          ...(logEntry.action === "ELIMINATE" &&
            authUser.id === logEntry.app_user && {
              character: logEntry.character,
            }),
          ...((logEntry.action === "PICK_TOKEN" ||
            logEntry.action === "SPECIFIC_TOKEN") && {
            token: logEntry.token,
          }),
        })),
      };
    })
  );

  ////////////////////////////////////////////////////////////////
  // take a game turn as the user
  ////////////////////////////////////////////////////////////////
  app.post<GameIdPathParam>(
    "/game/:gameId",
    basicAuth,
    handleResponse(async (req) => {
      const { gameId } = req.params;
      const authUser = req.user as AppUserTable;

      const { rows: gameRows } = await db.query<GameTable>(
        `SELECT *
           FROM sleuthers.game
          WHERE id = $1`,
        [gameId]
      );
      if (!gameRows.length) {
        throw new ErrorResponse(404, `Game ${gameId} not found`);
      }
      if (gameRows.length > 1) {
        throw new ErrorResponse(400, `Duplicate game ${gameId}`);
      }
      const [game] = gameRows;

      const { rows: users } = await db.query<GameUserTable & AppUserTable>(
        `SELECT *
           FROM sleuthers.game_user
           JOIN sleuthers.app_user
             ON game_user.app_user = app_user.id
          WHERE game = $1
          ORDER BY game_order`,
        [gameId]
      );

      for (let i = 0; i < users.length; i++) {
        if (users[i].game_order !== i) {
          throw "Bad user state";
        }
      }

      if (!users.find((user) => user.id === authUser.id)) {
        throw new ErrorResponse(404, `Game ${gameId} not found`);
      }

      const { rows: log } = await db.query<GameLogTable>(
        `SELECT *
           FROM sleuthers.game_log
          WHERE game = $1
          ORDER BY id`,
        [gameId]
      );
      if (!log.length) {
        throw "Illegal state";
      }

      const lastLog = log[log.length - 1];
      const nextLogId = lastLog.id + 1;
      const lastPlayerId = lastLog.app_user;
      const turnCount = (() => {
        let count = 1;
        while (
          count < log.length &&
          log[log.length - count - 1].app_user === lastPlayerId
        ) {
          count++;
        }
        return count;
      })();
      const curPlayerOrder = users.find((user) => user.id === lastPlayerId)!
        .game_order;
      const curPlayer = users[curPlayerOrder];

      if (authUser.id !== curPlayer.id) {
        throw new ErrorResponse(400, "Not your turn");
      }

      const getLocation = async (characterId: string): Promise<number> => {
        const { rows: characters } = await db.query<{ location: number }>(
          `SELECT location
             FROM sleuthers.game_character
            WHERE game = $1
              AND character = $2`,
          [gameId, characterId]
        );
        if (!characters.length) {
          throw new ErrorResponse(400, `Character ${characterId} not found`);
        }
        return characters[0].location;
      };

      const {
        type,
        cardId,
        characterId,
        tokenId,
        moveTo,
        sightUserId,
      } = req.body as ActionRequest;

      const characterLocation = characterId
        ? await getLocation(characterId)
        : undefined;

      if (
        moveTo !== undefined &&
        (!Number.isInteger(moveTo) || moveTo < 0 || moveTo > 11)
      ) {
        throw new ErrorResponse(
          400,
          "`moveTo` must be an integer from 0 to 11"
        );
      }

      const moveMatches = (move: string, die?: string): boolean =>
        !die || die === move;

      const movesMatch = (
        move1: string,
        move2: string,
        die1?: string,
        die2?: string
      ): boolean =>
        (moveMatches(move1, die1) && moveMatches(move2, die2)) ||
        (moveMatches(move1, die2) && moveMatches(move2, die1));

      const coords = (location: number): [number, number] => [
        location & 3,
        location >>> 2,
      ];

      const dist = (location1: number, location2: number): number => {
        const [x1, y1] = coords(location1);
        const [x2, y2] = coords(location2);
        return Math.abs(x1 - x2) + Math.abs(y1 - y2);
      };

      switch (turnCount) {
        ////////////////////////////////////////////////////////////////
        case 1: // ROLL
        case 2: // ROLL + MOVE
          ////////////////////////////////////////////////////////////////

          // validate move
          if (type !== "MOVE") {
            throw new ErrorResponse(400, "First two turn actions must be MOVE");
          }
          if (moveTo === undefined) {
            throw new ErrorResponse(
              400,
              "`moveTo` is required for MOVE action"
            );
          }
          if (!characterId) {
            throw new ErrorResponse(
              400,
              "`character` is required for MOVE action"
            );
          }
          const { die1, die2 } = log[log.length - turnCount];
          if (
            !(turnCount === 2
              ? movesMatch(lastLog.character!, characterId, die1, die2)
              : moveMatches(characterId, die1) ||
                moveMatches(characterId, die2))
          ) {
            throw new ErrorResponse(400, "Invalid move");
          }

          // can only move 1 space for first 2 actions
          if (dist(characterLocation!, moveTo) !== 1) {
            throw new ErrorResponse(400, "Must move exactly 1 space");
          }

          // insert log record
          await db.query<never>(
            `INSERT INTO sleuthers.game_log(game, id, app_user, action, character, move_from)
                                     VALUES($1  , $2, $3      , 'MOVE', $4       , $5       )`,
            [gameId, nextLogId, authUser.id, characterId, characterLocation]
          );

          // update character location
          await db.query<never>(
            `UPDATE sleuthers.game_character
                SET location = $1
              WHERE game = $2
                AND character = $3`,
            [moveTo, gameId, characterId]
          );

          return;

        ////////////////////////////////////////////////////////////////
        case 4: // ROLL + MOVE + MOVE + ACTION
          if (cardId !== lastLog.card) {
            throw new ErrorResponse(400, "Card did not match previous action");
          }
        case 3: // ROLL + MOVE + MOVE
          ////////////////////////////////////////////////////////////////
          if (!cardId) {
            throw new ErrorResponse(400, "Must select card");
          }
          const { rows: cards } = await db.query<
            GameUserCardTable & GameCardTable
          >(
            `SELECT * FROM sleuthers.game_user_card 
               JOIN sleuthers.game_card 
                 ON game_user_card.game = game_card.game 
                AND game_user_card.card = game_card.id 
              WHERE game_user_card.game = $1 
                AND game_user_card.card = $2 
                AND game_user_card.app_user = $3`,
            [gameId, cardId, authUser.id]
          );
          if (!cards.length) {
            throw new ErrorResponse(400, `Card ${cardId} not found`);
          }

          const [cardCharacterId, cardTokenId] = (() => {
            const [
              { action1, character1, token1, action2, character2, token2 },
            ] = cards;

            if (action1 === action2) {
              throw "Cannot distinguish actions";
            }

            if (
              !(turnCount === 4
                ? (action1 === lastLog.action && action2 === type) ||
                  (action1 === type && action2 === lastLog.action)
                : action1 === type || action2 === type)
            ) {
              throw new ErrorResponse(400, "Invalid action");
            }

            return action1 === type
              ? [character1, token1]
              : [character2, token2];
          })();

          const actionResult = await (async () => {
            switch (type) {
              ////////////////////////////////////////////////////////////////
              case "ELIMINATE":
                ////////////////////////////////////////////////////////////////

                // get random non-eliminated character, or none if all have been eliminated
                const getCharacterId = async () => {
                  const { rows: characters } = await db.query<{
                    character: string;
                  }>(
                    `SELECT character
                       FROM sleuthers.game_character
                      WHERE game = $1
                        AND NOT eliminated
                        AND character NOT IN (
                              SELECT character
                                FROM sleuthers.game_user
                               WHERE game = $1
                            )`,
                    [gameId]
                  );
                  return (
                    characters.length &&
                    characters[Math.floor(Math.random() * characters.length)]
                      .character
                  );
                };

                const eliminatedCharacterId =
                  (await getCharacterId()) ||
                  (await (async () => {
                    // go through the pile again
                    await db.query<never>(
                      `UPDATE sleuthers.game_character
                          SET eliminated = FALSE
                        WHERE game = $1`,
                      [gameId]
                    );

                    // this should always return something, after the update
                    return (await getCharacterId()) as string;
                  })());

                // insert log record
                await db.query<never>(
                  `INSERT INTO sleuthers.game_log(game, id, app_user, action     , card, character)
                                           VALUES($1  , $2, $3      , 'ELIMINATE', $4  , $5       )`,
                  [
                    gameId,
                    nextLogId,
                    authUser.id,
                    cardId,
                    eliminatedCharacterId,
                  ]
                );

                // mark character as elminated
                await db.query<never>(
                  `UPDATE sleuthers.game_character
                      SET eliminated = TRUE
                    WHERE game = $1
                      AND character = $2`,
                  [gameId, eliminatedCharacterId]
                );

                // return the eliminated character
                return eliminatedCharacterId;

              ////////////////////////////////////////////////////////////////
              case "MOVE":
                ////////////////////////////////////////////////////////////////

                // validate params
                if (moveTo === undefined) {
                  throw new ErrorResponse(
                    400,
                    "`moveTo` is required for MOVE action"
                  );
                }
                if (!characterId) {
                  throw new ErrorResponse(
                    400,
                    "`characterId` is required for MOVE action"
                  );
                }

                // validate that location is changed
                if (moveTo === characterLocation) {
                  throw new ErrorResponse(
                    400,
                    "Must move to a different space"
                  );
                }

                // insert log record
                await db.query<never>(
                  `INSERT INTO sleuthers.game_log(game, id, app_user, action, card, character, move_from)
                                           VALUES($1  , $2, $3      , 'MOVE', $4  , $5       , $6       )`,
                  [
                    gameId,
                    nextLogId,
                    authUser.id,
                    cardId,
                    characterId,
                    characterLocation,
                  ]
                );

                // update character location
                await db.query<never>(
                  `UPDATE sleuthers.game_character
                      SET location = $1
                    WHERE game = $2
                      AND character = $3`,
                  [moveTo, gameId, characterId]
                );

                return;

              ////////////////////////////////////////////////////////////////
              case "PICK_TOKEN":
                ////////////////////////////////////////////////////////////////

                if (!tokenId) {
                  throw new ErrorResponse(
                    400,
                    "`tokenId` is required for PICK_TOKEN action"
                  );
                }

                const { rows: locationRows } = await db.query<never>(
                  `SELECT 1
                     FROM sleuthers.game_token_location
                     JOIN sleuthers.game_character
                       ON game_token_location.game = game_character.game
                      AND game_token_location.location = game_character.location
                     JOIN sleuthers.game_user
                       ON game_character.game = game_user.game
                      AND game_character.character = game_user.character
                    WHERE game_token_location.game = $1
                      AND token = $2
                      AND app_user = $3`,
                  [gameId, tokenId, authUser.id]
                );
                if (!locationRows.length) {
                  throw new ErrorResponse(
                    400,
                    `You cannot pick up a ${tokenId}`
                  );
                }

                // insert log record
                await db.query<never>(
                  `INSERT INTO sleuthers.game_log(game, id, app_user, action      , card, token)
                                           VALUES($1  , $2, $3      , 'PICK_TOKEN', $4  , $5   )`,
                  [gameId, nextLogId, authUser.id, cardId, tokenId]
                );

                // increment user token count
                await db.query<never>(
                  `INSERT INTO sleuthers.game_user_token(game, app_user, token, count)
                                                  VALUES($1  , $2      , $3   , 1    )
                       ON CONFLICT (game, app_user, token) DO UPDATE
                      SET count = game_user_token.count + 1`,
                  [gameId, authUser.id, tokenId]
                );

                // decrement token stock count
                await db.query<never>(
                  `UPDATE sleuthers.game_token
                      SET count = game_token.count - 1
                    WHERE game = $1
                      AND token = $2`,
                  [gameId, tokenId]
                );

                return;

              ////////////////////////////////////////////////////////////////
              case "SIGHT":
                ////////////////////////////////////////////////////////////////

                if (!sightUserId) {
                  throw new ErrorResponse(
                    400,
                    "`sightUserId` is required for SIGHT action"
                  );
                }
                if (!cardCharacterId) {
                  throw "Expected character to be set";
                }

                const { rows: sightUsers } = await db.query<{
                  character: string;
                }>(
                  `SELECT character
                     FROM sleuthers.game_user
                    WHERE game = $1
                      AND app_user = $2`,
                  [gameId, sightUserId]
                );
                if (!sightUsers.length) {
                  throw new ErrorResponse(404, `User ${sightUserId} not found`);
                }

                const loc1 = await getLocation(cardCharacterId);
                const loc2 = await getLocation(sightUsers[0].character);

                const [x1, y1] = coords(loc1);
                const [x2, y2] = coords(loc2);
                const canSee = x1 === x2 || y1 === y2;

                // insert log record
                await db.query<never>(
                  `INSERT INTO sleuthers.game_log(game, id, app_user, action , card, character, sight_user, sight_result)
                                           VALUES($1  , $2, $3      , 'SIGHT', $4  , $5       , $6        , $7          )`,
                  [
                    gameId,
                    nextLogId,
                    authUser.id,
                    cardId,
                    cardCharacterId,
                    sightUserId,
                    canSee,
                  ]
                );

                return canSee;

              ////////////////////////////////////////////////////////////////
              case "SPECIFIC_TOKEN":
                ////////////////////////////////////////////////////////////////

                if (!cardTokenId) {
                  throw "Expected token to be set";
                }

                // insert log record
                await db.query<never>(
                  `INSERT INTO sleuthers.game_log(game, id, app_user, action          , card, token)
                                           VALUES($1  , $2, $3      , 'SPECIFIC_TOKEN', $4  , $5   )`,
                  [gameId, nextLogId, authUser.id, cardId, cardTokenId]
                );

                // increment user token count
                await db.query<never>(
                  `INSERT INTO sleuthers.game_user_token(game, app_user, token, count)
                                                  VALUES($1  , $2      , $3   , 1    )
                       ON CONFLICT (game, app_user, token) DO UPDATE
                      SET count = game_user_token.count + 1`,
                  [gameId, authUser.id, cardTokenId]
                );

                // decrement token stock count
                await db.query<never>(
                  `UPDATE sleuthers.game_token
                      SET count = game_token.count - 1
                    WHERE game = $1
                      AND token = $2`,
                  [gameId, cardTokenId]
                );

                return;

              default:
                throw new ErrorResponse(400, `Unexpected action type: ${type}`);
            }
          })();

          const {
            rows: [{ n: minTokens }],
          } = await db.query<{ n: number }>(
            `SELECT MIN(count) n
               FROM sleuthers.game_token
              WHERE game = $1`,
            [gameId]
          );

          if (minTokens < 1) {
            const stage: GameStage = (await isFinished(db, gameId))
              ? "FINISHED"
              : "GUESSING";

            await db.query<never>(
              `UPDATE sleuthers.game
                  SET stage = $1
                WHERE id = $2`,
              [stage, gameId]
            );
          } else if (turnCount === 4) {
            // get next turn started
            const { rows: characters } = await db.query<{ character: string }>(
              `SELECT character
                 FROM sleuthers.game_character
                WHERE game = $1`,
              [gameId]
            );

            const [die1, die2] = rollDice(characters.map((c) => c.character));

            const {
              rows: [{ app_user: nextUserId }],
            } = await db.query<{ app_user: string }>(
              `SELECT app_user
                 FROM sleuthers.game_user
                WHERE game = $1
                  AND game_order IN ($2, 0)
                ORDER BY game_order DESC
                LIMIT 1`,
              [gameId, curPlayerOrder + 1]
            );

            // insert log record for dice roll
            await db.query<never>(
              `INSERT INTO sleuthers.game_log(game, id, app_user, action, die1, die2)
                                       VALUES($1  , $2, $3      , 'ROLL', $4  , $5  )`,
              [gameId, nextLogId + 1, nextUserId, die1, die2]
            );

            // discard
            await db.query<never>(
              `DELETE FROM sleuthers.game_user_card
                WHERE game = $1
                  AND card = $2
                  AND app_user = $3`,
              [gameId, cardId, authUser.id]
            );

            // draw new card
            const { rows: nextCards } = await db.query<{ id: string }>(
              `SELECT id
                 FROM sleuthers.game_card
                WHERE game = $1
                  AND deck_order IS NOT NULL
                ORDER BY deck_order
                LIMIT 1`,
              [gameId]
            );

            if (nextCards.length) {
              const [{ id: cardId }] = nextCards;

              // remove card from deck
              await db.query<never>(
                `UPDATE sleuthers.game_card
                    SET deck_order = NULL
                  WHERE game = $1
                    AND id = $2`,
                [gameId, cardId]
              );

              // add card to hand
              await db.query<never>(
                `INSERT INTO sleuthers.game_user_card(game, card, app_user)
                                               VALUES($1  , $2  , $3      )`,
                [gameId, cardId, authUser.id]
              );
            } else {
              // TODO shuffle discard back in
              throw "Ran out of cards!";
            }
          }

          return actionResult;

        default:
          throw `Unexpected turn count: ${turnCount}`;
      }
    })
  );

  ////////////////////////////////////////////////////////////////
  // add/update a character guess
  ////////////////////////////////////////////////////////////////
  app.post<GameIdPathParam>(
    "/game/:gameId/guess",
    basicAuth,
    handleResponse(async (req) => {
      const { gameId } = req.params;
      const authUser = req.user as AppUserTable;

      const { characterId, userId, guess } = req.body as GuessPostRequest;
      if (!characterId) {
        throw new ErrorResponse(
          400,
          "`characterId` is required for guess update request"
        );
      }
      if (!userId) {
        throw new ErrorResponse(
          400,
          "`userId` is required for guess update request"
        );
      }
      if (typeof guess !== "boolean") {
        throw new ErrorResponse(
          400,
          "`guess` is required for guess update request"
        );
      }

      const { rows: gameRows } = await db.query<GameTable>(
        `SELECT *
           FROM sleuthers.game
          WHERE id = $1`,
        [gameId]
      );
      if (!gameRows.length) {
        throw new ErrorResponse(404, `Game ${gameId} not found`);
      }
      if (gameRows.length > 1) {
        throw new ErrorResponse(400, `Duplicate game ${gameId}`);
      }

      await db.query<never>(
        `INSERT INTO sleuthers.game_user_guess(game, app_user, character, target_user, guess)
                                        VALUES($1  , $2      , $3       , $4         , $5   )
             ON CONFLICT (game, app_user, character, target_user) DO UPDATE
            SET guess = EXCLUDED.guess`,
        [gameId, authUser.id, characterId, userId, guess]
      );

      if (await isFinished(db, gameId)) {
        await db.query<never>(
          `UPDATE sleuthers.game
              SET stage = 'FINISHED'
            WHERE id = $1`,
          [gameId]
        );
      }
    })
  );

  ////////////////////////////////////////////////////////////////
  // remove a character guess
  ////////////////////////////////////////////////////////////////
  app.delete<GameIdPathParam>(
    "/game/:gameId/guess",
    basicAuth,
    handleResponse(async (req) => {
      const { gameId } = req.params;
      const authUser = req.user as AppUserTable;

      const { characterId, userId } = req.body as GuessDeleteRequest;
      if (!characterId) {
        throw new ErrorResponse(
          400,
          "`characterId` is required for guess update request"
        );
      }
      if (!userId) {
        throw new ErrorResponse(
          400,
          "`userId` is required for guess update request"
        );
      }

      const { rows: gameRows } = await db.query<GameTable>(
        `SELECT *
           FROM sleuthers.game
          WHERE id = $1`,
        [gameId]
      );
      if (!gameRows.length) {
        throw new ErrorResponse(404, `Game ${gameId} not found`);
      }
      if (gameRows.length > 1) {
        throw new ErrorResponse(400, `Duplicate game ${gameId}`);
      }

      await db.query<never>(
        `DELETE FROM sleuthers.game_user_guess
          WHERE game = $1
            AND app_user = $2
            AND character = $3
            AND target_user = $4`,
        [gameId, authUser.id, characterId, userId]
      );

      if (await isFinished(db, gameId)) {
        await db.query<never>(
          `UPDATE sleuthers.game
              SET stage = 'FINISHED'
            WHERE id = $1`,
          [gameId]
        );
      }
    })
  );

  app.listen(port);
  console.log(`API started on port ${port}`);
})().catch((e) => console.log(e));
