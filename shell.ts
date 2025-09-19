import * as shellQuote from 'https://raw.githubusercontent.com/ProPuke/ts-shell-quote/master/index.ts';

let shell:string;

switch(Deno.build.os){
	case 'windows':
		shell = 'cmd';
	break;
	case 'linux':
	default:
		shell = '/bin/sh';
		// shell = Deno.env.get('SHELL') || shell;
	break;
}

export type ShellParams = (string|shellQuote.ShellCmdOp)[];

export function parse_params(params:string):string[] {
	const parsed = shellQuote.parse(params, Deno.env.toObject());

	const args:string[] = [];
	for(const term of parsed){
		if(typeof term == 'string'){
			args.push(term);
		}else if('op' in term){
			args.push(term.pattern||term.op);
		}
	}

	return args;
}

export function parse_shell_params(params:string, envvars = Deno.env.toObject()):ShellParams {
	const parsed = shellQuote.parse(params, envvars);

	const args:ShellParams = [];
	for(const term of parsed){
		if(typeof term == 'string'||'op' in term){
			args.push(term);
		}
	}

	return args;
}

export function quote_params(params:string[]):string {
	return shellQuote.quote(params);
}

export function quote_shell_params(params:ShellParams):string {
	return params.map(param => {
		return typeof param == 'string' ? shellQuote.quote([param]) : param.pattern||param.op;
	}).join(' ');
}

export async function execute(args:ShellParams, cwd?:string, envvars?:Record<string,string>):Promise<boolean> {
	// if(args.every(x => typeof x=='string')){
	// 	return execute_raw(args as string[], cwd);
	// }

	return execute_raw([shell, '-c', quote_shell_params(args)], cwd, envvars);
}

export async function execute_raw(args:string[], cwd?:string, envvars?:Record<string,string>):Promise<boolean> {
	const command = new Deno.Command(args[0], {
		args: args.slice(1),
		cwd,
		stdout: 'inherit',
		stderr: 'inherit',
		env: envvars
	});

	return (await command.output()).success;
}

export async function evaluate(args:ShellParams, cwd?:string, envvars?:Record<string,string>):Promise<string|false> {
	// if(args.every(x => typeof x=='string')){
	// 	return evaluate_raw(args as string[], cwd);
	// }

	return evaluate_raw([shell, '-c', quote_shell_params(args)], cwd, envvars);
}

export async function evaluate_raw(args:string[], cwd?:string, envvars?:Record<string,string>):Promise<string|false> {
	const command = new Deno.Command(args[0], {
		args: args.slice(1),
		cwd,
		env: envvars,
		stdout: 'piped',
		stderr: 'inherit'
	});


	const output = await command.output();
	if(!output.success){
		return false;
	}

	return (new TextDecoder).decode(output.stdout);
}
