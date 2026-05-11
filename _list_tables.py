import psycopg2, json

c = psycopg2.connect('postgresql://postgres:postgres@localhost:5432/tech4human_db')
cur = c.cursor()

# Find most recent transaction-agent thread for Lanre
cur.execute("""
    SELECT id, "resourceId", "createdAt"
    FROM mastra_threads
    WHERE id LIKE 'thread_+2349013360717%transaction%'
    ORDER BY "createdAt" DESC
    LIMIT 3
""")
threads = cur.fetchall()
print("Transaction agent threads for Lanre:")
for t in threads:
    print(' ', t)

if threads:
    tid = threads[0][0]
    print(f"\nMessages in thread {tid}:")
    cur.execute("""
        SELECT role, LEFT(content, 400), "createdAt"
        FROM mastra_messages
        WHERE thread_id = %s
        ORDER BY "createdAt"
        LIMIT 20
    """, (tid,))
    for r in cur.fetchall():
        print(f"  [{r[0]}] {r[1][:200]}")

c.close()
