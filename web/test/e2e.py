#!/usr/bin/env python3
"""End-to-end test: real page in headless Chrome against sim_vehicle.py over WebSocket."""
import re, sys
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080/"
WS = sys.argv[2] if len(sys.argv) > 2 else "ws://127.0.0.1:8765"
SHOTS = sys.argv[3] if len(sys.argv) > 3 else "/tmp"
expect_ftp = "--list" not in sys.argv

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(BASE)
    page.screenshot(path=f"{SHOTS}/01-connect.png")

    page.click('#linkChoices [data-link="mlrs"]')
    page.click('#transportChoices [data-transport="wifi"]')
    page.fill("#wsUrl", WS)
    page.click("#connectBtn")
    expect(page.locator("#appView")).to_be_visible(timeout=15000)
    expect(page.locator("#paramRows tr").first).to_be_visible(timeout=30000)
    expect(page.locator("#vehicleSummary")).to_contain_text("Plane")
    expect(page.locator("#vehicleSummary")).to_contain_text("4.6.3")
    docs_line = page.locator("#docsLine").inner_text()
    print("docs:", docs_line)
    assert "exact match" in docs_line, docs_line
    n_rows = page.locator("#paramRows tr").count()
    print("rows:", n_rows)
    assert n_rows >= 90

    if expect_ftp:
        assert "Defaults reported" in docs_line
        page.click('.seg [data-filter="modified"]')
        modified = page.locator("#paramRows td.name").all_inner_texts()
        print("modified:", modified)
        assert set(["PTCH_RATE_P", "AIRSPEED_CRUISE", "SERVO_AUTO_TRIM", "RC7_OPTION"]).issubset(modified), modified
        assert "RCMAP_ROLL" not in modified
    page.click('.seg [data-filter="undocumented"]')
    undoc = page.locator("#paramRows td.name").all_inner_texts()
    print("undocumented:", undoc)
    assert undoc == ["NEW_PARAM_X"], undoc
    page.click('.seg [data-filter="all"]')

    # search + details + edit
    page.fill("#paramSearch", "PTCH_RATE_P")
    page.wait_for_timeout(400)
    page.click('#paramRows tr[data-name="PTCH_RATE_P"] td.desc')
    expect(page.locator("#paramDetails")).to_contain_text("Pitch")
    page.screenshot(path=f"{SHOTS}/02-params.png")
    page.click('#paramRows tr[data-name="PTCH_RATE_P"] td.value')
    page.fill("#editValue", "0.9")
    page.click("#editOk")
    expect(page.locator("#pendingBar")).to_be_visible()
    page.click("#pendingReview")
    expect(page.locator("#reviewList")).to_contain_text("1.2 → 0.9")
    page.screenshot(path=f"{SHOTS}/03-review.png")
    page.click("#writeBtn")
    expect(page.locator("#reviewList .res.ok")).to_contain_text("vehicle reports 0.9", timeout=10000)
    page.keyboard.press("Escape")

    # Claude suggestions round trip (enum label accepted)
    page.click('.tabs [data-tab="claude"]')
    page.fill("#suggestions", "AIRSPEED_CRUISE = 20  # closer to default\nSTICK_MIXING = Disabled # test label\nNOT_A_PARAM = 3")
    page.click("#reviewSuggestions")
    expect(page.locator("#suggestStatus")).to_contain_text("2 changes added")
    expect(page.locator("#suggestStatus")).to_contain_text("NOT_A_PARAM")
    expect(page.locator("#reviewList")).to_contain_text("Claude: closer to default")
    page.screenshot(path=f"{SHOTS}/04-claude-review.png")
    page.click("#writeBtn")
    expect(page.locator("#reviewList .res.ok")).to_have_count(2, timeout=10000)
    page.keyboard.press("Escape")

    # RC mapping: switch on ch6 flips every 3 s
    page.click('.tabs [data-tab="rc"]')
    expect(page.locator("#lastMoved")).to_contain_text("channel 6", timeout=8000)
    expect(page.locator('#rcRows tr[data-ch="7"] .option select')).to_have_value("4")
    expect(page.locator('#rcRows tr[data-ch="1"] .func')).to_have_text("Roll")
    page.select_option('#rcRows select[data-assign="3"]', "Yaw")  # throttle is on 3, yaw on 4: they swap
    expect(page.locator('#pendingText')).to_contain_text("2 pending")
    expect(page.locator('#rcRows tr[data-ch="3"] .func')).to_have_text("Yaw")
    expect(page.locator('#rcRows tr[data-ch="4"] .func')).to_have_text("Throttle")
    page.screenshot(path=f"{SHOTS}/05-rc.png")
    page.click("#pendingReview")
    expect(page.locator("#reviewList")).to_contain_text("RCMAP_YAW")
    expect(page.locator("#reviewList")).to_contain_text("Swapped")
    browser.close()
    if errors:
        print("page errors:", errors)
        sys.exit(1)
    print("E2E OK")
