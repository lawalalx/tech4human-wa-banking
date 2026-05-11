import psycopg2, json

c = psycopg2.connect('postgresql://postgres:postgres@localhost:5432/tech4human_db')
cur = c.cursor()

# All threads for Lanre after latest clear
cur.execute("""
    SELECT id, "resourceId", "createdAt"
    FROM mastra_threads
    WHERE id LIKE 'thread_+2349013360717%'
    ORDER BY "createdAt" DESC
    LIMIT 10
""")
threads = cur.fetchall()
print("All Lanre threads (newest first):")
for t in threads:
    print(' ', t)

# Show messages from the MOST RECENT thread
if threads:
    tid = threads[0][0]
    print(f"\nMessages in thread {tid}:")
    cur.execute("""
        SELECT role, LEFT(content, 500), "createdAt"
        FROM mastra_messages
        WHERE thread_id = %s
        ORDER BY "createdAt"
    """, (tid,))
    for r in cur.fetchall():
        print(f"  [{r[0]}] {r[1][:300]}")
        print()

c.close()

