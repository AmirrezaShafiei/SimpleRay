"""Optional UI smoke test. Requires: Python playwright + Chromium; npm run dev server."""
from playwright.sync_api import sync_playwright

URI = 'vless://11111111-2222-4333-8444-555555555555@germany.test:443?security=tls#Germany%2001'
SUB_URI = 'trojan://password@france.test:443?security=tls#France%2001'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1440, 'height':950})
    errors=[]
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.route('https://example.org/test-sub',lambda route: route.fulfill(status=200,headers={'access-control-allow-origin':'*','content-type':'text/plain'},body=SUB_URI))
    page.goto('http://127.0.0.1:1420/',wait_until='networkidle')
    assert page.locator('#serverRows tr').count()==0
    page.locator('#pasteMenuButton').click()
    page.locator('#manualAddButton').click()
    page.locator('#manualUri').fill(URI)
    page.locator('#manualName').fill('My Germany')
    page.locator('#manualForm button[type=submit]').click()
    assert page.locator('#serverRows tr').count()==1
    assert 'My Germany' in page.locator('#serverRows').inner_text()
    page.locator('#pasteMenuButton').click()
    page.locator('#subscriptionAddButton').click()
    page.locator('#subscriptionName').fill('My Subscription')
    page.locator('#subscriptionUrl').fill('https://example.org/test-sub')
    page.locator('#subscriptionForm button[type=submit]').click()
    page.wait_for_function('document.querySelectorAll("#serverRows tr").length===2',timeout=9000)
    assert 'My Subscription' in page.locator('#serverRows').inner_text()
    page.locator('[data-sort="source"]').click()
    page.locator('[data-sort="source"]').click()
    assert page.locator('[data-sort="source"]').get_attribute('data-active')=='true'
    page.locator('#serverRows tr').first.locator('.star').click()
    page.locator('#settingsButton').click()
    page.locator('.appearance-option.light').click()
    assert page.locator('html').get_attribute('data-theme')=='light'
    page.locator('.theme-tile.custom').click()
    page.locator('#themeWheel').click(position={'x': 105, 'y': 60})
    assert page.locator('html').get_attribute('data-palette')=='custom'
    page.locator('#settingsClose').click()
    row=page.locator('#serverRows tr',has_text='France 01')
    row.locator('.rename-config').click()
    row.locator('.rename-input').fill('Renamed France')
    row.locator('.rename-input').press('Enter')
    assert page.locator('#serverRows tr',has_text='Renamed France').count()==1
    page.locator('#updateButton').click()
    page.wait_for_function("document.querySelector('#toast').textContent.includes('1/1')")
    assert page.locator('#serverRows tr',has_text='Renamed France').count()==1
    page.reload(wait_until='networkidle')
    assert page.locator('#serverRows tr').count()==2
    assert page.locator('html').get_attribute('data-theme')=='light'
    page.locator('#settingsButton').click()
    page.locator('.appearance-option.dark').click()
    page.locator('#settingsClose').click()
    assert not errors, f'Browser errors: {errors}'
    print('Browser UI smoke passed: manual add, mocked subscription fetch, source, sorting, favorites, theme, reload persistence')
    browser.close()
