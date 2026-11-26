#!/usr/bin/env node
/**
 * RisuStand Admin Utility — Token Revoke/Rotate & Server Port Management
 * Zero-dependency Node.js (v18+) CLI & exported helpers.
 *
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Required Notice: Copyright (c) 2026 rusinus12
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DEFAULT_PORT = 8787;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const TOKEN_FILE = '.risustand-token';
const PORT_FILE = '.risustand-port';

function parsePortNumber(raw) {
    const s = String(raw ?? '').trim();
    if (!/^\d+$/.test(s)) {
        throw new Error(`올바른 포트 번호(숫자 ${MIN_PORT}~${MAX_PORT})를 입력하세요.`);
    }
    const n = Number(s);
    if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
        throw new Error(`포트 번호는 ${MIN_PORT}~${MAX_PORT} 사이여야 합니다.`);
    }
    return n;
}

function readPortFile(rootDir = __dirname) {
    const portPath = path.join(rootDir, PORT_FILE);
    try {
        if (!fs.existsSync(portPath)) return DEFAULT_PORT;
        const raw = fs.readFileSync(portPath, 'utf8').trim();
        return parsePortNumber(raw);
    } catch (_) {
        return DEFAULT_PORT;
    }
}

function writeAtomicPrivate(filePath, content) {
    const tmp = `${filePath}.rs-tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, filePath);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        throw e;
    }
}

function writePortFile(rootDir = __dirname, port) {
    const n = parsePortNumber(port);
    writeAtomicPrivate(path.join(rootDir, PORT_FILE), `${n}\n`);
    return n;
}

function resetPortFile(rootDir = __dirname) {
    const portPath = path.join(rootDir, PORT_FILE);
    try {
        fs.rmSync(portPath, { force: true });
    } catch (_) {}
    return DEFAULT_PORT;
}

function readTokenFile(rootDir = __dirname) {
    const tokenPath = path.join(rootDir, TOKEN_FILE);
    try {
        if (!fs.existsSync(tokenPath)) return '';
        return fs.readFileSync(tokenPath, 'utf8').trim();
    } catch (_) {
        return '';
    }
}

function validateCustomToken(raw) {
    const tok = String(raw ?? '').trim();
    if (tok.length < 8 || tok.length > 128) {
        throw new Error('토큰은 8자 이상 128자 이하여야 합니다.');
    }
    if (/\s|[\x00-\x1f]/.test(tok)) {
        throw new Error('토큰에는 공백이나 제어 문자를 포함할 수 없습니다.');
    }
    return tok;
}

function rotateToken(rootDir = __dirname, { customToken } = {}) {
    const previous = readTokenFile(rootDir);
    const next = customToken !== undefined && customToken !== null && String(customToken).trim() !== ''
        ? validateCustomToken(customToken)
        : crypto.randomBytes(16).toString('hex');
    writeAtomicPrivate(path.join(rootDir, TOKEN_FILE), `${next}\n`);
    return { previous, token: next };
}

function revokeToken(rootDir = __dirname) {
    const tokenPath = path.join(rootDir, TOKEN_FILE);
    const existed = fs.existsSync(tokenPath);
    try {
        fs.rmSync(tokenPath, { force: true });
    } catch (_) {}
    return { existed };
}

function maskToken(tok) {
    const s = String(tok || '').trim();
    if (!s) return '(없음)';
    if (s.length <= 8) return `${s.slice(0, 2)}...${s.slice(-2)}`;
    return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (ans) => {
            rl.close();
            resolve(String(ans || '').trim());
        });
    });
}

function parseCliFlags(argv) {
    const sub = argv[0] || '';
    const args = argv.slice(1);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--rotate') flags.rotate = true;
        else if (a === '--revoke') flags.revoke = true;
        else if (a === '--reset') flags.reset = true;
        else if (a === '--set' && i + 1 < args.length) flags.set = args[++i];
        else if (a.startsWith('--set=')) flags.set = a.slice(6);
    }
    return { sub, flags };
}

async function runTokenCli(rootDir, flags) {
    const cur = readTokenFile(rootDir);
    if (flags.rotate) {
        const res = rotateToken(rootDir);
        console.log('[OK] 기존 토큰을 폐기하고 새 랜덤 토큰을 발급했습니다.');
        console.log(`  새 보안 토큰: ${res.token}`);
        printTokenNextSteps();
        return;
    }
    if (flags.set !== undefined) {
        const res = rotateToken(rootDir, { customToken: flags.set });
        console.log('[OK] 기존 토큰을 폐기하고 지정한 토큰으로 변경했습니다.');
        console.log(`  새 보안 토큰: ${res.token}`);
        printTokenNextSteps();
        return;
    }
    if (flags.revoke) {
        const res = revokeToken(rootDir);
        console.log(res.existed
            ? '[OK] 기존 .risustand-token 파일을 완전히 삭제(폐기)했습니다.'
            : '[INFO] 삭제할 .risustand-token 파일이 이미 없습니다.');
        console.log('  * 다음 서버 시작 시 새로운 랜덤 토큰이 자동 생성됩니다.');
        printTokenNextSteps();
        return;
    }

    console.log('======================================================');
    console.log('  RisuStand 보안 토큰 폐기 / 변경');
    console.log('======================================================');
    console.log(`  현재 토큰 : ${maskToken(cur)}`);
    console.log('');
    console.log('  1) 새 랜덤 토큰 재발급 (기존 토큰 즉시 폐기)');
    console.log('  2) 원하는 토큰으로 직접 변경 (8자 이상)');
    console.log('  3) 토큰 파일 완전 폐기 (삭제 — 다음 서버 실행 시 자동 생성)');
    console.log('  0) 취소');
    console.log('');

    const choice = await ask('번호를 선택하세요 [1/2/3/0]: ');
    if (choice === '1') {
        const res = rotateToken(rootDir);
        console.log('');
        console.log('[OK] 새 랜덤 토큰이 발급되었습니다 (기존 토큰 폐기됨).');
        console.log(`  새 보안 토큰: ${res.token}`);
        printTokenNextSteps();
    } else if (choice === '2') {
        const custom = await ask('새 토큰 입력 (공백 없이 8자 이상): ');
        const res = rotateToken(rootDir, { customToken: custom });
        console.log('');
        console.log('[OK] 토큰이 변경되었습니다 (기존 토큰 폐기됨).');
        console.log(`  새 보안 토큰: ${res.token}`);
        printTokenNextSteps();
    } else if (choice === '3') {
        const res = revokeToken(rootDir);
        console.log('');
        console.log(res.existed
            ? '[OK] 토큰 파일(.risustand-token)을 완전히 폐기했습니다. 다음 서버 실행 시 새 토큰이 생성됩니다.'
            : '[INFO] 이미 토큰 파일이 없습니다.');
        printTokenNextSteps();
    } else {
        console.log('취소되었습니다.');
    }
}

function printTokenNextSteps() {
    console.log('');
    console.log('  [적용 방법]');
    console.log('  1. 실행 중인 중계 서버를 끄고(stop-risustand-remote.bat) 다시 켜 주세요(start-risustand-remote.bat).');
    console.log('  2. PC RisuAI -> RisuStand 원격 접속 설정 및 Custom API 키에 새 토큰을 입력해 주세요.');
    console.log('  3. 기존에 접속해 있던 휴대폰/기기는 자동으로 401 로그아웃되며, 새 토큰으로 재로그인해야 합니다.');
}

async function runPortCli(rootDir, flags) {
    const cur = readPortFile(rootDir);
    if (flags.reset) {
        resetPortFile(rootDir);
        console.log(`[OK] 서버 포트를 기본값(${DEFAULT_PORT})으로 초기화했습니다.`);
        printPortNextSteps(DEFAULT_PORT);
        return;
    }
    if (flags.set !== undefined) {
        const next = writePortFile(rootDir, flags.set);
        console.log(`[OK] 서버 포트를 ${next} 번으로 변경했습니다.`);
        printPortNextSteps(next);
        return;
    }

    console.log('======================================================');
    console.log('  RisuStand 중계 서버 포트 변경');
    console.log('======================================================');
    console.log(`  현재 설정 포트 : ${cur}`);
    console.log(`  입력 가능 범위 : ${MIN_PORT}~${MAX_PORT} (기본값 복원은 8787 또는 reset)`);
    console.log('  취소하려면 빈 칸으로 Enter를 누르세요.');
    console.log('');

    const raw = await ask('새 포트 번호 입력: ');
    if (!raw) {
        console.log('취소되었습니다.');
        return;
    }
    if (raw.toLowerCase() === 'reset' || raw === String(DEFAULT_PORT)) {
        resetPortFile(rootDir);
        console.log('');
        console.log(`[OK] 서버 포트를 기본값 ${DEFAULT_PORT} 번으로 설정했습니다.`);
        printPortNextSteps(DEFAULT_PORT);
        return;
    }
    const next = writePortFile(rootDir, raw);
    console.log('');
    console.log(`[OK] 서버 포트를 ${next} 번으로 저장했습니다 (.risustand-port).`);
    printPortNextSteps(next);
}

function printPortNextSteps(port) {
    console.log('');
    console.log('  [적용 방법]');
    console.log('  1. 서버를 재시작해 주세요: stop-risustand-remote.bat -> start-risustand-remote.bat');
    console.log(`  2. PC RisuAI 브릿지 주소 : http://127.0.0.1:${port}`);
    console.log(`  3. PC RisuAI 프록시 URL    : http://127.0.0.1:${port}/v1/chat/completions`);
    console.log(`  4. 휴대폰 접속 주소       : http://<PC-Tailscale-IP>:${port}`);
    console.log(`  5. (Windows 방화벽 필요 시) netsh advfirewall firewall add rule name="RisuStand Relay ${port}" dir=in action=allow protocol=TCP localport=${port}`);
}

async function main() {
    const { sub, flags } = parseCliFlags(process.argv.slice(2));
    const rootDir = __dirname;
    if (sub === 'token') {
        await runTokenCli(rootDir, flags);
    } else if (sub === 'port') {
        await runPortCli(rootDir, flags);
    } else {
        console.error('사용법: node risustand-admin.cjs <token|port> [--rotate|--set <값>|--revoke|--reset]');
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[ERROR] ${err && err.message ? err.message : String(err)}`);
        process.exit(1);
    });
}

module.exports = {
    DEFAULT_PORT,
    MIN_PORT,
    MAX_PORT,
    TOKEN_FILE,
    PORT_FILE,
    parsePortNumber,
    readPortFile,
    writePortFile,
    resetPortFile,
    readTokenFile,
    validateCustomToken,
    rotateToken,
    revokeToken,
    maskToken,
};
