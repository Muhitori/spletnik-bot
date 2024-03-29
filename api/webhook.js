process.env.NTBA_FIX_319 = "test";
import dotenv from "dotenv";
import telegraf from "telegraf";

import {
	RUMORS_IN_MESSAGE,
	RUMOR_BUTTON_KEY,
	AGE_BUTTON_KEY,
	CITY_BUTTON_KEY,
	ADD_RUMOR,
	FIND_RUMOR,
} from "../utils/constants.js";
import {
	getChunks,
	getRumorsKeyboard,
	getCityKeyboard,
	getAgeKeyboard,
	parseButtonKey,
} from "../utils/helpers.js";
import { RumorService } from "../services/RumorService.js";
import { DBService } from "../services/DBService.js";
import { StatisticsService } from "../services/StatisticsService.js";

dotenv.config();

const {
	Telegraf,
	session,
	Scenes: { WizardScene, Stage },
	Markup,
} = telegraf;

export const bot = new Telegraf(process.env.BOT_TOKEN);

const exitKeyboard = Markup.keyboard(["/exit"]).oneTime().resize();
const skipKeyboard = Markup.keyboard(["/skip", "/exit"]).oneTime().resize();
const startKeyboard = Markup.keyboard(["/start"]).oneTime().resize();
const removeKeyboard = Markup.removeKeyboard();

let rumorService = null;
let statisticsService = null;

const connectServices = async () => {
	const { database } = await DBService.connect();

	rumorService = new RumorService(database);
	statisticsService = new StatisticsService(database);
};

bot.command("start", async (ctx) => {
	if (process.env.NODE_ENV === "development") {
		connectServices();
	}

	const inlineKeyboard = {
		inline_keyboard: [
			[
				{
					text: "Найти слухи",
					callback_data: "find_rumor",
				},
				{
					text: "Пустить слух",
					callback_data: "add_rumor",
				},
			],
		],
	};

	const welcomeMessage = `Привет, я Сплетник - бот для создания, поиска и распространения слухов (да-да, грязных - в том числе!).	\nНиже две кнопки:\n\n
		1. «Найти слух»\nНажми, введи имя, фамилию и город того человека, про которого хочешь узнать слухи. Если там пусто - что же, либо этот человек святой, либо дико скучный.\n
		2. «Пустить слух»\nЯ знаю, тебе есть что рассказать!\nНажми, введи имя, фамилию, возраст и город того, о ком ты хочешь написать анонимные сплетни. Пусть все знают!\n
		Не забудь скинуть меня друзьям!\n@sspletnik_bot`;

	bot.telegram.sendMessage(ctx.chat.id, welcomeMessage, {
		reply_markup: inlineKeyboard,
	});
});

const findRumorFlow = new WizardScene(
	"findRumorFlow",
	async (ctx) => {
		ctx.session.current = {};
		ctx.session.current.name = ctx.message.text.toLowerCase();
		await ctx.reply("Введите фамилию:", exitKeyboard);

		return ctx.wizard.next();
	},
	async (ctx) => {
		ctx.session.current.surname = ctx.message.text.toLowerCase();
		const cities = await rumorService.getCities(ctx.session.current);

		if (cities.length) {
			await ctx.reply(`Выберите город:`, {
				reply_markup: getCityKeyboard(cities),
			});
		} else {
			const { name, surname } = ctx.session.current;

			const { id: userId, username } = ctx.update.message.from;
			const record = {
				action: FIND_RUMOR,
				userId,
				username,
				botName: ctx.me,
			};

			await statisticsService.createRecord(record);

			await ctx.reply(
				`Судя по всему, никто ничего не написал про ${name} ${surname}. Будьте первым!`,
				startKeyboard
			);
		}

		return ctx.scene.leave();
	}
);
findRumorFlow.enter((ctx) =>
	ctx.reply("Введите имя (желательно - полное):", exitKeyboard)
);

const addRumorFlow = new WizardScene(
	"addRumorFlow",
	async (ctx) => {
		ctx.scene.state.name = ctx.message.text.toLowerCase();
		await ctx.reply("Введите фамилию:", exitKeyboard);

		return ctx.wizard.next();
	},
	async (ctx) => {
		ctx.scene.state.surname = ctx.message.text.toLowerCase();
		await ctx.reply("Введите ник в телеграмме если есть:", skipKeyboard);

		return ctx.wizard.next();
	},
	async (ctx) => {
		if (ctx.message.text !== "/skip") {
			ctx.scene.state.username = ctx.message.text;
		}

		await ctx.reply("Введите возраст:", exitKeyboard);

		return ctx.wizard.next();
	},
	async (ctx) => {
		ctx.scene.state.age = Number(ctx.message.text);
		await ctx.reply("Введите город:", exitKeyboard);

		return ctx.wizard.next();
	},
	async (ctx) => {
		ctx.scene.state.city = ctx.message.text.toLowerCase();
		await ctx.reply(
			"Напишите, что вы знаете про этого человека?:",
			exitKeyboard
		);

		return ctx.wizard.next();
	},
	async (ctx) => {
		ctx.scene.state.rumor = ctx.message.text;
		await rumorService.addRumor(ctx.scene.state);

		const { username: targetUsername } = ctx.scene.state;

		if (targetUsername && targetUsername !== "/skip") {
			const user = await statisticsService.getRecord(targetUsername);

			if (user) {
				bot.telegram.sendMessage(user.userId, "О вас создали слух!");
			}
		}

		const { id: userId, username } = ctx.update.message.from;
		const record = {
			action: ADD_RUMOR,
			userId,
			username,
			botName: ctx.me,
		};

		await statisticsService.createRecord(record);

		const { name, surname } = ctx.scene.state;

		await ctx.reply(`Слух про ${name} ${surname} добавлен!`, startKeyboard);
		return ctx.scene.leave();
	}
);
addRumorFlow.enter((ctx) =>
	ctx.reply("Введите имя (желательно - полное):", exitKeyboard)
);

const stage = new Stage([findRumorFlow, addRumorFlow]);
stage.hears("/exit", (ctx) => {
	ctx.reply(`Начать заново?`, startKeyboard);
	ctx.scene.leave();
});

bot.use(session());
bot.use(stage.middleware());

bot.on("callback_query", async (ctx) => {
	const { data } = ctx.update.callback_query;

	if (data === "find_rumor") {
		ctx.scene.enter("findRumorFlow");
	}

	if (data === "add_rumor") {
		ctx.scene.enter("addRumorFlow");
	}

	if (data.includes(CITY_BUTTON_KEY)) {
		ctx.session.current.city = parseButtonKey(data).toLowerCase();
		const ages = await rumorService.getAges(ctx.session.current);

		await ctx.reply(`Выберите возраст:`, {
			reply_markup: getAgeKeyboard(ages),
		});
	}

	if (data.includes(AGE_BUTTON_KEY)) {
		ctx.session.current.age = Number(parseButtonKey(data));
		const rumorsText = await rumorService.getRumors(ctx.session.current);

		const { id: userId, username } = ctx.update.callback_query.from;

		const record = {
			action: FIND_RUMOR,
			userId,
			username,
			botName: ctx.me,
		};

		await statisticsService.createRecord(record);

		const rumors = getChunks(rumorsText, RUMORS_IN_MESSAGE).map((chunk) =>
			chunk.map((rumor) => `Многие говорят: ${rumor}`).join("\n\n")
		);

		await ctx
			.reply(rumors[0], { reply_markup: getRumorsKeyboard(rumors, 0) })
			.then((message) => {
				ctx.session.rumors = rumors;
				ctx.session.messageId = message.message_id;
			});
	}

	if (data.includes(RUMOR_BUTTON_KEY)) {
		const { rumors, messageId } = ctx.session;
		const currentIndex = Number(parseButtonKey(data));

		ctx.editMessageText(rumors[currentIndex], {
			message_id: messageId,
			reply_markup: getRumorsKeyboard(rumors, currentIndex),
		});
	}
});

bot.catch((err, ctx) => console.log(err));

export default async (request, response) => {
	try {
		const { body } = request;

		if (body.message || body.callback_query) {
			await connectServices();
			await bot.handleUpdate(body);
		}
	} catch (error) {
		console.error("Error sending message");
		console.log(error.toString());
	}

	response.send("OK");
};
