import * as fs from 'https://deno.land/std@0.135.0/fs/mod.ts';
import * as path from "https://deno.land/std@0.136.0/path/mod.ts";
// import * as shellQuote from "https://raw.githubusercontent.com/shopstic/ts-shell-quote/master/index.ts";
import * as shellQuote from "https://raw.githubusercontent.com/ProPuke/ts-shell-quote/fix/invalid-parse-return-type/index.ts";
import * as color from "https://deno.land/std@0.136.0/fmt/colors.ts";

enum Verbosity {
	none,
	tasks,
	tasksAndCommands,
	debug
}

const programName = import.meta.url.match(/(?:^|\/)([^\\\/\.]+)(\.[^\\\/\.]*)?$/)?.[1]||'boop';
const programVersion = `1.0.0`;

const scriptName = 'tasks.boop';
let taskName = '';
let dryRun = false;
let jobs = 0;
let watch = false;
let verbosity = Verbosity.tasks;
const flags:string[] = [];

function print_help() {
	console.log(`Usage: ${programName} [OPTION]... [TASK] [FLAGS]...`);
	console.log(`Run the TASK in the ${scriptName} script, passing it specified FLAGS`);
	console.log();
	console.log(`  -d, --dry-run          do not actually execute commands (useful with --verbose)`);
	console.log(`  -h, --help             display this help and exit`);
	console.log(`  -j [N], --jobs=[N]     set how many tasks may be executed in parallel at once (defaults to 0)`);
	console.log(`                           N=0 - run no more than the number of cpu cores + 1`);
	console.log(`                           N=X - run no more than x`);
	console.log(`  -v [N], --verbose[=N]  set verbosity (defaults to 1)`);
	console.log(`                           N=0 - print no additional information`);
	console.log(`                           N=1 - print which tasks are being executed`);
	console.log(`                           N=2 - ...also print the commands which are being executed`);
	console.log(`                           N=3 - ...also print debug info about script lines being executed`);
	console.log(`  -w, --watch            watch all files for changes and restart task whenever they change`);
	console.log(`      --version          display version information and exit`);
}

function print_version() {
	console.log(`Boop! v${programVersion}`);
}

let _log_verbose_last = '';
function log_verbose(allowRepeat:boolean, line:string) {
	if(!allowRepeat&&_log_verbose_last==line) return;
	console.log(line);
	_log_verbose_last = line;
}

let _log_status_last = '';
function log_status_action(line:string) {
	if(_log_status_last==line) return;
	console.error(color.brightYellow(`» ${line}`));
	_log_status_last = line;
}

function log_status_failure(line:string) {
	console.error(color.red(`✖ ${line}`));
}

function log_status_success(line:string) {
	console.log(color.green(`✓ ${line}`));
}

const _file_search_cache = new Map<string, Promise<fs.WalkEntry[]>>();
function clear_file_search_cache() {
	_file_search_cache.clear();
}
async function file_search(glob:string) {
	const existing = _file_search_cache.get(glob);
	if(existing){
		return existing;
	}

	const items = (async() => {
		const items:fs.WalkEntry[] = [];

		for await(const item of fs.expandGlob(glob, { extended:false, globstar:true })){
			items.push(item);
		}
	
		return items;
	})();

	_file_search_cache.set(glob, items);

	return items;
}

const _file_date_cache = new Map<string, number|null>();
function clear_file_date_cache() {
	_file_date_cache.clear();
}
async function file_date(path:string, useCache = true) {
	if(useCache){
		const existing = _file_date_cache.get(path);
		if(existing){
			return existing;
		}
	}

	let date:number|null = null;

	try{
		const stat = await Deno.stat(path);
		if(stat.isFile&&stat.mtime){
			date = stat.mtime.valueOf();
		}
	}catch(error){}

	_file_date_cache.set(path, date);
	return date;
}

function find_basedirs_of_globs(globs:string[]):string[] {
	const dirs:string[] = [];

	for(const glob of globs){
		const dir = path.normalize(path.dirname(glob.replace(/(^|\/)\*\*\/.*/g, '*.*')));
		if(dirs.includes(dir)) continue;

		dirs.push(dir);
	}

	// remove dir entries nested within others (relative paths without ../ or /)
	for(let i=0;i<dirs.length;i++){
		const dirA = dirs[i];
		for(let i2=0;i2<dirs.length;i2++){
			if(i==i2) continue;

			const dirB = dirs[i2];

			const relative = path.relative(dirA, dirB);
			if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)){
				dirs.splice(i2, 1);
				if(i2<i) i--;
				i2--;
				continue;
			}
		}
	}

	return dirs;
}

class JobPool {
	readonly limit:number;
	#queue:{tags:Symbol[], fulfill:(run:boolean)=>void}[] = [];
	#activeJobs = 0;
	#jobsRan = 0;
	#cancelledTags:Symbol[] = [];

	constructor(limit:number) {
		this.limit = limit;
	}

	get activeJobs() { return this.#activeJobs; }
	get jobsRan() { return this.#jobsRan; }

	async begin_job(tags:Symbol[] = []) {
		//check to make sure the tags aren't cancelled
		for(const cancelled of this.#cancelledTags){
			if(tags.includes(cancelled)){
				return false;
			}
		}

		if(this.#activeJobs>=this.limit){
			let fulfill!:(run:boolean)=>void;
			const promise = new Promise<boolean>(function(resolve){ fulfill=resolve; });
			this.#queue.push({tags:[], fulfill});
			const next = await promise;

			// check in case the tags were cancelled while waiting
			for(const cancelled of this.#cancelledTags){
				if(tags.includes(cancelled)){
					return false;
				}
			}

			return next;
		}
		this.#activeJobs++;
		return true;
	}

	async end_job() {
		this.#activeJobs--;
		this.#jobsRan++;
		const queued = this.#queue.shift();
		if(queued){
			queued.fulfill(true);
		}
	}

	cancel_remaining() {
		let queued:{tags:any[], fulfill:(run:boolean)=>void}|undefined;
		while(queued = this.#queue.shift()){
			queued.fulfill(false);
		}
	}

	cancel_tag(tag:Symbol, blacklist = true) {
		if(blacklist){
			this.#cancelledTags.push(tag);
		}

		for(let i=0;i<this.#queue.length;i++){
			const queued = this.#queue[i];
			if(queued.tags.includes(tag)){
				this.#queue.splice(i--, 1);
				queued.fulfill(false);
			}
		}
		let queued:{tags:any[], fulfill:(run:boolean)=>void}|undefined;
		while(queued = this.#queue.shift()){
			queued.fulfill(false);
		}
	}
}

for(let i=0;i<Deno.args.length;i++){
	const arg = Deno.args[i];
	
	if(arg[0]=='-'){
		switch(arg){
			case '-h':
			case '--help':
				print_help();
				Deno.exit(0);
			break;
			case '-d':
			case '--dry-run':
				dryRun = true;
			break;
			case '-j': {
				const next = i+1<Deno.args.length?Deno.args[i+1]:null;
				const value = next!==null?parseInt(next, 10):NaN;
				
				if(isNaN(value)){
					jobs = 0;

				}else if(value>=0){
					jobs = value;
					i++;

				}else{
					console.error(`Invalid job limit: ${value}`);
				}
			} break;
			case '-v': {
				const next = i+1<Deno.args.length?Deno.args[i+1]:null;
				const value = next!==null?parseInt(next, 10):NaN;

				if(isNaN(value)){
					verbosity = Verbosity.tasks;

				}else{
					i++;
					switch(value){
						case 0:
							verbosity = Verbosity.none;
						break;
						case 1:
							verbosity = Verbosity.tasks;
						break;
						case 2:
							verbosity = Verbosity.tasksAndCommands;
						break;
						case 3:
							verbosity = Verbosity.debug;
						break;
						default:
							console.error(`Invalid verbosity level: ${value}`)
							console.log();
							print_help();
							Deno.exit(1);
					}
				}
			} break;
			case '--verbose=0':
				verbosity = Verbosity.none;
			break;
			case '--verbose':
			case '--verbose=1':
				verbosity = Verbosity.tasks;
			break;
			case '--verbose=2':
				verbosity = Verbosity.tasksAndCommands;
			break;
			case '--verbose=3':
				verbosity = Verbosity.debug;
			break;
			case '-w':
			case '--watch':
				watch = true;
			break;
			case '--version':
				print_version();
				Deno.exit(0);
			break;
			default: {
				let match;
				if(match=arg.match(/^--jobs=(\S+)/)){
					const value = parseInt(match[1], 10);
					
					if(value>=0){
						jobs = value;
	
					}else{
						console.error(`Invalid job limit: ${value}`);
						console.log();
						print_help();
						Deno.exit(1);
					}
				}

				console.error(`Invalid option: ${arg}`);
				console.log();
				print_help();
				Deno.exit(1);
			}
		}
	}else{
		if(!taskName){
			taskName = arg;
		}else{
			flags.push(arg);
		}
	}
}

if(!taskName){
	print_help();
	Deno.exit(0);
}

if(jobs<1){
	jobs = navigator.hardwareConcurrency+1;
}

const runQueue = new JobPool(jobs);

function params_parse(params:string):string[] {
	const parsed = shellQuote.parse(params, Deno.env.toObject());

	const args:string[] = [];
	for(const term of parsed){
		if(typeof term == 'string'){
			args.push(term);
		}else if('op' in term && term.pattern){
			args.push(term.pattern);
		}
	}

	return args;
}

function params_quote(params:string[]):string {
	return shellQuote.quote(params);
}

async function run_process(tags:any[], args:string[]):Promise<true|false|'aborted'> {
	if(!await runQueue.begin_job(tags)) return 'aborted';

	let success = false;

	try{
		const process = Deno.run({
			cmd: args
		});

		success = (await process.status()).success;
	}catch(error){
		console.error(error.message);
	}

	await runQueue.end_job();

	return success;
}

type ScriptLine = {
	lineNumber:number;
	indent:number;
	source:string;
};

type ParsedLine = {
	type: 'run',
	optional: boolean,
	command: string,
	source: string,
	debugVars: string
}

class ParseError extends Error {
	constructor(public lineNumber:number, error:string){
		super(error);
	}
}

type Task = {
	name: string,
	providedFiles: string[],
	taskDependenciesByName: { optional: boolean, name: string }[],
	taskDependencies: { optional: boolean, task: Task }[],
	fileDependencies: string[],
	// netProvidedFiles: string[],
	// netFileDependencies: string[],
	parsedLines: ParsedLine[]
};

type ScriptExecution = {cancel:()=>void, promise:Promise<true|false|'aborted'>};

class Script {
	readonly lines:ScriptLine[] = [];
	readonly tasks:Task[] = [];
	readonly globs:string[] = [];
	readonly modifiedFiles:string[] = [];
	currentJobs = new WeakMap<Task, Promise<boolean|'aborted'>>();

	constructor(source:string= '') {
		let i = 0;
		for(const line of source.split('\n')){
			if(!line){
				i++;
				continue;
			}
			const indent = (line.match(/^([ \t]*)/)?.[1]||'').replaceAll('  ', '\t').length;
			this.lines.push({lineNumber:i, indent, source:line.trimStart()});
			i++;
		}
	}

	clear_current_jobs() {
		this.currentJobs = new WeakMap<Task, Promise<boolean|'aborted'>>();
	}

	async compile(flags:string[] = []) {
		await this.compileRegion(undefined, 0, this.lines.length, new Map<string,string>(), flags);

		const finalTaskPass = (task:Task, parentNames:string[]) => {
			const childNames = [...parentNames, task.name];

			// task.netFileDependencies = [...task.fileDependencies];
			// task.netProvidedFiles = [...task.providedFiles];

			for(const dependency of task.taskDependenciesByName){
				if(childNames.includes(dependency.name)){
					console.error(`Circular task dependency detected: `, childNames.join(' -> ')+` -> ${dependency.name}`);
					continue;
				}

				for(const childTask of this.tasks){
					if(childTask.name==dependency.name){
						task.taskDependencies.push({optional: dependency.optional, task:childTask});
						// finalTaskPass(childTask, childNames);
						// for(const file of childTask.fileDependencies){
						// 	if(!task.netFileDependencies.includes(file)){
						// 		task.netFileDependencies.push(file);
						// 	}
						// }
						// for(const file of childTask.providedFiles){
						// 	if(!task.netProvidedFiles.includes(file)){
						// 		task.netProvidedFiles.push(file);
						// 	}
						// }
					}
				}
			}

			// // file dependencies that are self-provided needn't propagate outward to parents as they've been fulfilled internally (but provided files still propagate)
			// for(let i=0;i<task.netFileDependencies.length;i++){
			// 	if(task.netProvidedFiles.includes(task.netFileDependencies[i])){
			// 		task.netFileDependencies.splice(i--, 1);
			// 	}
			// }
		}

		for(const task of this.tasks){
			finalTaskPass(task, []);
		}
	}

	execute(tags:Symbol[], taskName:string):ScriptExecution {
		const tasks = this.tasks.filter((x) => x.name==taskName);

		if(tasks.length<1){
			console.error(`Nothing to do for task "${taskName}"`);
			return {cancel:()=>{}, promise:Promise.resolve(false)};
		}

		return this.execute_tasks(tags, `running task "${taskName}"`, tasks);
	}

	execute_tasks(tags:Symbol[], description:string, tasks:Task[]):ScriptExecution {
		const currentRunTag = Symbol();
		tags = [...tags, currentRunTag];

		const jobs:Promise<true|false|'aborted'>[] = [];

		const childExecutions:ScriptExecution[] = [];

		let isCancelled = false;

		const cancel = () => {
			isCancelled = true
			runQueue.cancel_tag(currentRunTag);
			for(const child of childExecutions){
				child.cancel();
			}
		};

		return { cancel, promise: (async () => {
			{
				const taskJobs:Promise<true|false|'aborted'>[] = [];

				for(const task of tasks){
					let promise = this.currentJobs.get(task);

					if(!promise){
						promise = (async() => {
							// check all task dependencies first...
							{
								const dependencyJobs:Promise<true|false|'aborted'>[] = [];

								let isFinished = false;

								for(const [i, dependency] of task.taskDependencies.entries()){
								// const job = jobs[i];
									dependencyJobs.push((async () => {
										const childTask = this.execute_tasks(tags, `running task "${dependency.task.name}"`, [dependency.task]);
										childExecutions.push(childTask)

										const result = await childTask.promise;
										
										switch(result){
											case true:
											break;
											case false:
												if(!dependency.optional){
													// await Promise.allSettled(dependencyJobs);
													if(!isFinished) {
														isFinished = true;
														log_status_failure(`Could not run "${taskName}" task, as "${dependency.task.name}" task failed`);
														runQueue.cancel_tag(currentRunTag);
														return 'aborted';
													}
													return false;
												}
											break;
											case 'aborted':
												// await Promise.allSettled(dependencyJobs);
												isFinished = true;
												runQueue.cancel_tag(currentRunTag);
												return 'aborted';
											break;
										}

										return true;
									})());
								}

								const completed = await Promise.allSettled(dependencyJobs);

								if(isCancelled) return 'aborted';

								// if any solid failures, fail
								for(const result of completed){
									if(result.status!='fulfilled'||result.value===false){
										return false;
									}
								}

								// otherwise, if there were silent aborts, silently abort
								for(const result of completed){
									if(result.status=='fulfilled'&&result.value=='aborted'){
										return 'aborted';
									}
								}
							}

							let newestDate:number|null = null;

							// check for all dependent files second.. (so that tasks can create them)
							{
								const dependencyJobs:Promise<boolean>[] = [];

								let isFinished = false;

								for(const dependency of task.fileDependencies){
									dependencyJobs.push((async () => {
										const date = await file_date(dependency);
										if(!date){
											if(!isFinished) {
												isFinished = true;
												log_status_failure(`Error attempting to run "${taskName}" task: Required file "${dependency}" was not found.`);
												runQueue.cancel_tag(currentRunTag);
											}
											return false;
										}
										if(newestDate===null||date>newestDate){
											newestDate = date;
										}

										return true;
									})());
								}

								const completed = await Promise.allSettled(dependencyJobs);

								if(isCancelled) return 'aborted';

								for(const result of completed){
									if(result.status!='fulfilled'||!result.value){
										return false;
									}
								}
							}

							let outOfDate = false;

							// check if task is out of date
							if(!task.providedFiles.length){
								outOfDate = true;
							}else{
								for(const provide of task.providedFiles){
									const date = await file_date(provide);
									if(date===null||newestDate&&date<newestDate){
										outOfDate = true;
										break;
									}
								}
							}

							// execute actions
							if(outOfDate){
								if(verbosity>=Verbosity.tasks) {
									log_status_action(`${color.bold('Executing')} "${task.name}" task...`);
								}

								// mark all files we're about to change
								for(const file of task.providedFiles){
									if(!this.modifiedFiles.includes(file)){
										this.modifiedFiles.push(file);
									}
								}

								for(const line of task.parsedLines){
									if(verbosity>=Verbosity.debug) {
										log_verbose(true, `>> ${line.source}`);
										if(line.debugVars){
											log_verbose(true, `   (${line.debugVars})`);
										}
									}

									if(verbosity>=Verbosity.tasksAndCommands) {
										log_verbose(true, `> ${line.command}`);
									}

									if(!dryRun) {
										const result = await run_process(tags, params_parse(line.command));
										if(isCancelled) return 'aborted';
											
										if(line.optional&&result===false) return true;

										if(result!==true){
											runQueue.cancel_tag(currentRunTag);
											break;
										}
									}
								}

								//update cached data on all provided files, as they may have been updated
								for(const provides of task.providedFiles){
									const date = await file_date(provides, false);
								}
							}

							return true;
						})();

						this.currentJobs.set(task, promise);
					}
					
					taskJobs.push(promise);
					jobs.push(promise);
				}

				await Promise.allSettled(taskJobs);
			}

			const completed = await Promise.allSettled(jobs);

			if(isCancelled){
				return 'aborted';
			}

			// if any solid failures, fail
			for(const result of completed){
				if(result.status!='fulfilled'||result.value===false){
					log_status_failure(`${color.bold('Failure')} ${description}`);
					return false;
				}
			}

			// otherwise, if there were silent aborts, silently abort
			for(const result of completed){
				if(result.status=='fulfilled'&&result.value=='aborted'){
					return 'aborted';
				}
			}

			return true;
		})()};
	}

	async compileRegion(currentTask:Task|undefined, start:number, end:number, vars:Map<string,string>, flags:string[] = []) {
		const parse = async(line:ScriptLine, value:string):Promise<string> => {
			const replaceTasks:Promise<string>[] = [];

			value.replaceAll(/{(.*?)}/g, (fullstring:string, expression:string) => {
				replaceTasks.push((async() => {
					let match:RegExpMatchArray|null;
					if(match = expression.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*\.\s*([a-zA-Z_][a-zA-Z0-9_-]*))?$/)){
						const varName = match[1];
						const property = match[2] as string|undefined;
						const value = vars.get(varName)||'';
						if(property!==undefined){
							switch(property){
								case 'dir':
									return params_quote([path.dirname(value)]);
	
								case 'file':
									return params_quote([path.basename(value)]);
	
								case 'ext':
									return params_quote([path.extname(value)]);
	
								case 'name':
									return params_quote([path.basename(value, path.extname(value))]);
	
								default:
									throw new ParseError(line.lineNumber, `No such property: ${property}`);
							}
						}
	
						return value?value:'';
	
					}else if(match = expression.match(/^\s*(\S*\*\S*)(?:\s+as (\S+))?\s*$/)){
						const glob = match[1];
						const rename = match[2];
	
						let renamePrefix = '';
						let renameKeep = true;
						let renamePostfix = '';
						let renameExtension:string|false = false;

						if(!this.globs.includes(glob)){
							this.globs.push(glob);
						}
	
						if(rename){
							match = rename.match(/^([^*]*)(\*)([^*]*)(?:\.)(\*|[^*]*)$/);
							if(!match){
								throw new ParseError(line.lineNumber, `Invalid rename glob: ${rename}`);
							}
							renamePrefix = match[1];
							renameKeep = match[2]=='*';
							renamePostfix = match[3];
							renameExtension = match[4]=='*'?false:match[4];
						}
	
						const filenames:string[] = [];

						for(const file of await file_search(glob)){
							if(file.isFile){
								let filename = file.path;
	
								if(rename){
									const dirname = path.dirname(filename);
									const extensionEnding = renameExtension?`.${renameExtension}`:'';
									const basename = renameExtension==undefined?path.basename(filename):path.basename(filename, path.extname(filename));
	
									filename = (dirname?`${dirname}/`:'')+renamePrefix+(renameKeep?basename:'')+renamePostfix+extensionEnding;
								}
	
								filenames.push(filename);
							}
						}
	
						return params_quote(filenames);
	
					}else{
						throw new ParseError(line.lineNumber, `Invalid expression: ${expression}`);
					}
				})());
				return fullstring;
			});

			const replacements = await Promise.all(replaceTasks);

			const result = value.replaceAll(/{(.*?)}/g, () => replacements.shift() as string );

			return result;
		}

		for(let i=start;i<end;i++){
			const line = this.lines[i];

			let match:RegExpMatchArray|null;
			if(!line.source){
				continue;

			}else if(match = line.source.match(/^#/)){
				continue;

			}else if(match = line.source.match(/^provides\s+(.+)$/)){
				const items = params_parse(await parse(line, match[1]));
				if(!currentTask) throw new ParseError(line.lineNumber, "Cannot use 'provides` outside of a task");
				if(items){
					for(let item of items){
						currentTask.providedFiles.push(item);
					}
				}

			}else if(match = line.source.match(/^requires\s+(?:(?:(optional)\s+)?(task)\s+)?(.+)$/)){
				const isTask = !!match[2];
				const isOptional = !!match[1];
				const items = params_parse(await parse(line, match[3]));
				if(!currentTask) throw new ParseError(line.lineNumber, "Cannot use 'requires` outside of a task");
				if(items) {
					for(let item of items){
						if(isTask){
							currentTask.taskDependenciesByName.push({ optional:isOptional, name:item });
						}else{
							currentTask.fileDependencies.push(item);
						}
					}
				}

			}else if(match = line.source.match(/^set\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(.*)$/)){
				const name = match[1];
				const value = await parse(line, match[2]);
				vars.set(name, value);

			}else if(match = line.source.match(/^flag\s+(not\s*)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*$/)){
				const not = match[1];
				const flag = match[2];

				const succeed = flags.includes(flag)==!not;

				// skip indented if not valid
				if(!succeed){
					while(i+1<this.lines.length){
						if(this.lines[i+1].indent<=line.indent) break;
						i++;
					}
					continue;
				}

			}else if(match = line.source.match(/^(optional\s+)?run\s+(.*)$/)){
				const isOptional = !!match[1];
				const command = await parse(line, match[2]);
				if(!currentTask) throw new ParseError(line.lineNumber, "Cannot use 'run` outside of a task");

				const debugVars:string[] = [];
				if(verbosity>=Verbosity.debug){
					for(const [name,value] of vars.entries()){
						debugVars.push(`${name}=${JSON.stringify(value)}`);
					}
				}
				
				currentTask.parsedLines.push({ type: 'run', optional: isOptional, command: command, source: line.source, debugVars:debugVars.join(' ') });

			}else if(match = line.source.match(/^task\s+(.*)$/)){
				const name = await parse(line, match[1]);

				let end = i+1;
				while(end<this.lines.length){
					if(this.lines[end].indent<=line.indent) break;
					end++;
				}

				currentTask = {
					name,
					providedFiles: [],
					fileDependencies: [],
					taskDependenciesByName: [],
					taskDependencies: [],
					// netProvidedFiles: [],
					// netFileDependencies: [],
					parsedLines: []
				};

				this.tasks.push(currentTask);
				await this.compileRegion(currentTask, i+1, end, vars, flags);

				i = end-1;

			}else if(match = line.source.match(/^each\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s+in\s+(\S.*?)\s*$/)){
				const name = match[1];
				const values = params_parse(await parse(line, match[2])).map(x => params_quote([x]));

				let end = i+1;
				while(end<this.lines.length){
					if(this.lines[end].indent<=line.indent) break;
					end++;
				}

				const shadowedVar = vars.get(name);

				if(values){
					for(const value of values){
						vars.set(name, value);

						await this.compileRegion(currentTask, i+1, end, vars, flags);

						if(shadowedVar===undefined){
							vars.delete(name);
						}else{
							vars.set(name, shadowedVar);
						}
					}
				}

				i = end-1;

			}else{
				// result.lines.push({ lineNumber:line.lineNumber, indent:line.indent, source:line.source });
				throw new ParseError(line.lineNumber, `Invalid line: ${line.source}`);
			}
		}
	}
}

let source:string;

async function run():Promise<boolean> {
	try{
		source = await Deno.readTextFileSync(scriptName);
	}catch(error){
		console.error(`Unable to read ${scriptName}`);
		return false;
	}

	try{
		const script = new Script(source);
		await script.compile(flags);
	
		if(watch){
			await run_watch(script, flags);
	
		}else{
			if(await run_once(script, flags)===false){
				return false;
			}
		}
		
	}catch(error){
		if(error instanceof ParseError){
			console.error(`Error in ${scriptName}:${error.lineNumber}: ${error.message}`);
			return false;
		}else{
			throw error;
		}
	}

	return true;
}

async function run_once(script:Script, flags:string[]):Promise<true|false|'aborted'> {
	const result = await script.execute([], taskName).promise;
	if(result===true){
		log_status_success(`${color.bold('Success')} running task "${taskName}"`);
	}

	return result;
}

async function run_watch(script:Script, flags:string[]) {
	const cwd = Deno.cwd();
	const globs:string[] = [];
	const regexes:RegExp[] = [];
	const filenames = new Set<string>();

	for(const x of script.globs){
		const glob = path.joinGlobs([cwd, x], { extended:false, globstar:true });
		globs.push(x);
		regexes.push(path.globToRegExp(glob, { extended:false, globstar:true, caseInsensitive:false }));
	}

	let basedirs = find_basedirs_of_globs(globs);

	for(const task of script.tasks){
		for(const name of task.fileDependencies){
			const filename = path.resolve(name);
			const dirname = path.dirname(filename);
			if(!basedirs.includes(dirname)){
				basedirs.push(dirname);
			}
			filenames.add(filename);
		}
	}

	let currentTimeout:number|undefined;

	let activeScript:Script|undefined = script;
	let task:ScriptExecution|undefined = activeScript.execute([], taskName);
	let taskJobsBefore = 0;
	let lastModifiedFiles:string[] = [];
	task.promise.then((result) => {
		lastModifiedFiles = activeScript?activeScript.modifiedFiles:[];
		activeScript = undefined;
		task = undefined;

		if(runQueue.jobsRan>0){
			if(result===true){
				log_status_success(`${color.bold('Success')} running task "${taskName}"`);
				console.log();
			}else if(result===false){
				console.log();
			}
		}
	});

	{ // reduce to just the basedirs that exist (to avoid watch errors)
		let validBaseDirs:string[] = [];
		for(const path of basedirs){
			try{
				const stat = await Deno.stat(path);
				if(!stat.isDirectory) throw false;
				validBaseDirs.push(path);

			}catch(error){
				log_status_failure(`Base directory not found: ${path}`);
			}
		}
		basedirs = validBaseDirs;
	}

	if(basedirs.length<1){
		log_status_failure(`No files to be watched, found in ${scriptName}. Executing task just once...`);
		console.log();

	}else{
		log_status_action(`${color.bold('Watching')} for file changes (in ${basedirs.join('/ ')}/)`);
		console.log();
	}

	const scriptPath = path.resolve(scriptName);

	const fsWatcher = Deno.watchFs([...basedirs, scriptPath], { recursive: true });

	let scriptChanged = false;

	for await(const event of fsWatcher){
		let filesMatched = false;
		let scriptMatched = false;
		const modifiedFiles = activeScript?activeScript.modifiedFiles:lastModifiedFiles;

		for(let eventPath of event.paths){
			eventPath = path.normalize(eventPath);

			if(eventPath==scriptPath){
				scriptMatched = true;
				break;

			}else{
				if(filenames.has(eventPath)&&!modifiedFiles.some(modified => path.resolve(modified) == eventPath)){
					filesMatched = true;
				}else{
					for(const regex of regexes){
						if(regex.test(eventPath)){
							if(modifiedFiles.some(modified => path.resolve(modified) == eventPath)){
								break;
							}
							// console.log(eventPath);
							filesMatched = true;
							break;
						}
					}
				}
				if(filesMatched) break;
			}
		}

		if(scriptMatched||filesMatched){
			clearTimeout(currentTimeout);

			const now = Date.now();
			const scheduled = now+700;

			if(task){
				console.log(`${scriptMatched?'Script':'Files'} changed during active task. Cancelling...`);
				task.cancel();
				await task.promise;
				
			}else{
				if(scriptMatched&&!scriptChanged){
					console.log(`Script changed. Restarting...`);
				}
			}

			if(scriptMatched){
				scriptChanged = true;
			}

			currentTimeout = setTimeout(async () => {
				console.clear();
				
				clear_file_search_cache();
				clear_file_date_cache();

				if(scriptChanged){
					// slight hack >.> cancel the watch and restart from run() so we restart everything from scratch
					fsWatcher.close();
					if(!await run()){
						Deno.exit(1);
					}

				}else{
					const script = new Script(source);
					await script.compile(flags);
					taskJobsBefore = runQueue.jobsRan;
					activeScript = script;
					task = activeScript.execute([], taskName);
					task.promise.then((result) => {
						lastModifiedFiles = activeScript?activeScript.modifiedFiles:[];
						activeScript = undefined;
						task = undefined;
						if(result===true){
							if(runQueue.jobsRan>taskJobsBefore){
								log_status_success(`${color.bold('Success')} running task "${taskName}"`);
								console.log();
							}

						}else if(result===false){
							console.log();
						}
					});
				}

			}, Math.max(0, scheduled-Date.now()));
		}
	}
}

if(!await run()){
	Deno.exit(1);
}
