import assert from "node:assert";
import test, { describe } from "node:test";

import { lexShell, MAX_COMMAND_LENGTH } from "../shell-lexer.js";

const dyn = (cmd: string) =>
	lexShell(cmd)
		.commands[0].words.slice(1)
		.map((x) => x.dynamic);
const words = (cmd: string) =>
	lexShell(cmd).commands.map((c) => c.words.map((w) => w.text));

describe("lexShell", () => {
	test("splits words and removes quotes and escapes", () => {
		assert.deepStrictEqual(words("ls -la  src"), [["ls", "-la", "src"]]);
		assert.deepStrictEqual(words(`echo 'a b' "c d" e\\ f`), [
			["echo", "a b", "c d", "e f"],
		]);
		// Quotes inside a word join its parts.
		assert.deepStrictEqual(words(`r"m" -r'f'`), [["rm", "-rf"]]);
		assert.deepStrictEqual(words("r\\m"), [["rm"]]);
	});

	test("operators inside quotes are not operators", () => {
		for (const cmd of [
			`echo "a;b"`,
			`echo 'a|b'`,
			`echo "a && b"`,
			`echo 'a > b'`,
			`echo "a\`b"`.replace("`", "\\`"),
			`grep 'x\ny' f`,
		]) {
			const lexed = lexShell(cmd);
			assert.strictEqual(lexed.commands.length, 1, cmd);
			assert.deepStrictEqual(lexed.commands[0].redirects, [], cmd);
			assert.strictEqual(lexed.unparseable, undefined, cmd);
		}
	});

	test("escaped operators are literal", () => {
		assert.deepStrictEqual(words("echo a\\;b"), [["echo", "a;b"]]);
		assert.deepStrictEqual(words("echo a\\|b \\> c"), [
			["echo", "a|b", ">", "c"],
		]);
	});

	test("a pipeline and a list are several simple commands", () => {
		const lexed = lexShell("cat f | grep x && ls ; pwd || true\nwc");
		assert.deepStrictEqual(
			lexed.commands.map((c) => [c.words[0].text, c.after]),
			[
				["cat", null],
				["grep", "|"],
				["ls", "&&"],
				["pwd", ";"],
				["true", "||"],
				["wc", "\n"],
			],
		);
	});

	test("background and trailing separators", () => {
		assert.strictEqual(lexShell("sleep 1 &").background, true);
		assert.strictEqual(lexShell("ls;").unparseable, undefined);
		assert.strictEqual(lexShell("ls\n").unparseable, undefined);
		assert.strictEqual(lexShell("a &&\n b").unparseable, undefined);
	});

	test("redirections, with and without a file descriptor", () => {
		const [cmd] = lexShell("make > out 2>&1 < in 2>/dev/null").commands;
		assert.deepStrictEqual(
			cmd.redirects.map((r) => [r.fd, r.op, r.target.text]),
			[
				[undefined, ">", "out"],
				["2", ">&", "1"],
				[undefined, "<", "in"],
				["2", ">", "/dev/null"],
			],
		);
		assert.deepStrictEqual(words("echo 2"), [["echo", "2"]]);
		assert.strictEqual(
			lexShell("echo x &> f").commands[0].redirects[0].op,
			"&>",
		);
		assert.strictEqual(
			lexShell("echo x >> f").commands[0].redirects[0].op,
			">>",
		);
	});

	test("command and process substitution are collected", () => {
		const a = lexShell('echo $(date +%s) `id` "$(whoami)" <(ls) >(cat)');
		assert.deepStrictEqual(a.substitutions, [
			"date +%s",
			"id",
			"whoami",
			"ls",
			"cat",
		]);
		assert.ok(a.commands[0].words.slice(1).every((w) => w.dynamic));
	});

	test("substitutions nest and respect quotes", () => {
		const a = lexShell('echo $(echo $(echo ")") x)');
		assert.strictEqual(a.unparseable, undefined);
		assert.deepStrictEqual(a.substitutions, ['echo $(echo ")") x']);
		assert.deepStrictEqual(lexShell("echo \"a $(echo ')') b\"").substitutions, [
			"echo ')'",
		]);
	});

	test("a substitution inside single quotes is literal text", () => {
		const a = lexShell("echo '$(id)' '`id`'");
		assert.deepStrictEqual(a.substitutions, []);
		assert.deepStrictEqual(words("echo '$(id)'"), [["echo", "$(id)"]]);
		assert.strictEqual(a.commands[0].words[1].dynamic, false);
	});

	test("backslash-escaped dollar and backtick in double quotes are literal", () => {
		const a = lexShell('echo "\\$(id) \\`id\\`"');
		assert.deepStrictEqual(a.substitutions, []);
		assert.deepStrictEqual(a.commands[0].words[1].text, "$(id) `id`");
	});

	test("variables, ANSI-C quotes and brace lists are dynamic", () => {
		assert.deepStrictEqual(dyn('echo $HOME ${X:-y} $1 $? "$A"'), [
			true,
			true,
			true,
			true,
			true,
		]);
		assert.deepStrictEqual(dyn("echo $'\\x72\\x6d'"), [true]);
		assert.deepStrictEqual(dyn("echo {a,b} {1..3}"), [true, true]);
		assert.deepStrictEqual(dyn("echo {} a{b"), [false, false]);
		assert.deepStrictEqual(dyn("echo '$HOME' $ a$"), [false, false, false]);
	});

	test("globs and tildes are flagged only when unquoted", () => {
		const [cmd] = lexShell("ls *.ts '*.ts' ~/x \"~/x\" a?b [ab]").commands;
		const flags = cmd.words.slice(1).map((w) => [w.glob, w.tilde]);
		assert.deepStrictEqual(flags, [
			[true, false],
			[false, false],
			[false, true],
			[false, false],
			[true, false],
			[true, false],
		]);
	});

	test("assignments before the command are not words", () => {
		const [cmd] = lexShell("FOO=1 BAR=$(id) ls x=y").commands;
		assert.deepStrictEqual(cmd.assignments, ["FOO=1"]);
		assert.strictEqual(cmd.words[0].dynamic, true);
	});

	test("comments are dropped, but # inside a word is not a comment", () => {
		assert.deepStrictEqual(words("ls # rm -rf ~"), [["ls"]]);
		assert.deepStrictEqual(words("echo a#b"), [["echo", "a#b"]]);
		assert.deepStrictEqual(words("echo '#'"), [["echo", "#"]]);
	});

	test("line continuations join lines", () => {
		assert.deepStrictEqual(words("ls \\\n -la"), [["ls", "-la"]]);
	});

	test("heredocs and here-strings", () => {
		const h = lexShell("cat <<EOF\nhello\nEOF");
		assert.strictEqual(h.heredoc, true);
		assert.strictEqual(lexShell("cat <<-'EOF'\nx\nEOF").heredoc, true);
		assert.strictEqual(lexShell("cat <<< hi").heredoc, false);
	});

	test("groups and subshells", () => {
		assert.strictEqual(lexShell("(cd x && ls)").group, true);
		assert.strictEqual(lexShell("ls").group, false);
	});

	test("unparseable input is reported, not guessed", () => {
		for (const bad of [
			"echo 'unterminated",
			'echo "unterminated',
			"echo $(unterminated",
			"echo `unterminated",
			"echo trailing\\",
			"ls |",
			"ls &&",
			"| ls",
			"; ls",
			"ls ;; ls",
			"ls >",
			"cat <",
			"echo $'unterminated",
			"echo ${unterminated",
			"a\0b",
			"ls ; ; ls",
		]) {
			assert.ok(lexShell(bad).unparseable, JSON.stringify(bad));
		}
	});

	test("an over-long command and over-deep nesting are unparseable", () => {
		assert.ok(lexShell("a".repeat(MAX_COMMAND_LENGTH + 1)).unparseable);
		assert.ok(lexShell("ls", 99).unparseable);
	});

	test("never throws on odd input", () => {
		const odd = [
			"",
			" ",
			"\n",
			"&",
			")",
			"(",
			"$",
			"$(",
			"<<",
			">",
			"'",
			'"',
			"`",
			"\\",
			"$'",
			"{",
			"}",
		];
		for (const o of odd) lexShell(o);
		for (let i = 0; i < 300; i++) {
			const chars = "ab ;|&<>()$`'\"\\\n#{}*~=".split("");
			let s = "";
			for (let j = 0; j < 12; j++)
				s += chars[(i * 7 + j * 13 + (i >> 2) * j) % chars.length];
			lexShell(s);
		}
	});
});
